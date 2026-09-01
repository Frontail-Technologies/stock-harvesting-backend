import { and, asc, count, desc, eq, gt, gte, ilike, lt, lte, not, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candles, instruments } from "../../db/schema";
import { getOrSetCache } from "../../shared/cache";
import { CANDLE_TIMEFRAME, DATA_PROVIDER_KEY, DEFAULT_EXCHANGE } from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import type { MoveFilter } from "./market-data.schemas";
import { safeProviderAction, syncLatestDailyCandlesForSymbols } from "./market-data.candle-sync";
import { hydrateDefaultMarketInstruments, syncProviderInstrumentSearch } from "./market-data.instrument-sync";
import { refreshLatestInstrumentStats } from "./market-data.instruments";

// Complete stock-list/search ownership: query construction, filtering,
// sorting, pagination, response-row shaping, AND the on-demand provider
// hydration orchestration around them (listStocks/listStocksUncached).
// The hydration orchestration depends on market-data.candle-sync.ts and
// market-data.instrument-sync.ts, neither of which import from this module
// or from market-data.service.ts - so this module can own the full
// responsibility with no import cycle. market-data.service.ts calls into
// this module; this module never calls back into the service.

export type StockSortField = "symbol" | "name" | "close" | "changePct" | "volume";
export type StockSortDirection = "asc" | "desc";

export const NSE_NORMAL_EQUITY_SYMBOL_PATTERN = "^[A-Z][A-Z0-9&-]*$";
// Bond/NCD "New" series tickers (e.g. "AAFS27A-N0", "826TN25-N3") all end in
// -N<digits> regardless of what precedes it - the previous pattern required
// the symbol to also start with a digit, so letter-prefixed debt series
// tickers slipped through the exclusion entirely.
const NSE_DEBT_SERIES_SYMBOL_PATTERN = "-N[0-9]+$";
const NSE_NON_EQ_SERIES_SYMBOL_PATTERN = "-(BE|BZ|SM|ST|SZ|E[0-9]+)$";

export function buildStockFilters(input: {
  q?: string;
  exchange: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const filters = [
    eq(instruments.exchange, input.exchange),
    eq(instruments.active, true),
    // Excludes Morningstar-style fund identifiers (e.g. "0P0001Y872") that
    // the provider's instrument search occasionally returns alongside real
    // tradeable tickers - no genuine stock symbol starts with a digit.
    not(ilike(instruments.symbol, "0%")),
    input.includeUnpriced ? undefined : gt(instruments.latestClose, "0"),
    input.exchange === "NSE" ? eq(instruments.provider, DATA_PROVIDER_KEY.zerodha) : undefined,
    input.exchange === "NSE" ? sql`${instruments.symbol} ~ ${NSE_NORMAL_EQUITY_SYMBOL_PATTERN}` : undefined,
    input.exchange === "NSE" ? not(sql`${instruments.symbol} ~ ${NSE_DEBT_SERIES_SYMBOL_PATTERN}`) : undefined,
    input.exchange === "NSE" ? not(sql`${instruments.symbol} ~ ${NSE_NON_EQ_SERIES_SYMBOL_PATTERN}`) : undefined,
    input.q
      ? or(ilike(instruments.symbol, `%${normalizeSymbol(input.q)}%`), ilike(instruments.name, `%${input.q.trim()}%`))
      : undefined,
    // NULL latestChangePct (not yet computed) naturally falls out of all
    // three comparisons below, so a stock without complete data is never
    // miscategorized as a gainer/decliner/unchanged.
    input.moveFilter === "gainers" ? gt(instruments.latestChangePct, "0") : undefined,
    input.moveFilter === "decliners" ? lt(instruments.latestChangePct, "0") : undefined,
    input.moveFilter === "unchanged" ? eq(instruments.latestChangePct, "0") : undefined,
    input.minVolume !== undefined ? gte(instruments.latestVolume, String(input.minVolume)) : undefined,
  ].filter(Boolean);

  return and(...filters);
}

export function buildStockOrderBy(sortBy: StockSortField = "name", sortDirection: StockSortDirection = "asc") {
  const direction = sortDirection === "desc" ? desc : asc;
  const primaryColumn =
    sortBy === "symbol"
      ? instruments.symbol
      : sortBy === "name"
        ? instruments.name
        : sortBy === "close"
          ? instruments.latestClose
          : sortBy === "changePct"
            ? instruments.latestChangePct
            : instruments.latestVolume;
  const tiebreakerColumn = instruments.symbol;

  return [direction(primaryColumn), asc(tiebreakerColumn)];
}

export async function countStockRows(
  input: {
    q?: string;
    exchange: string;
    moveFilter?: MoveFilter;
    minVolume?: number;
    includeUnpriced?: boolean;
  },
  dbClient: DbOrTx = db
) {
  const [result] = await dbClient.select({ total: count() }).from(instruments).where(buildStockFilters(input));

  return result?.total ?? 0;
}

export async function readStockRows(
  input: {
    q?: string;
    page: number;
    limit: number;
    sortBy?: StockSortField;
    sortDirection?: StockSortDirection;
    exchange: string;
    moveFilter?: MoveFilter;
    minVolume?: number;
    includeUnpriced?: boolean;
  },
  dbClient: DbOrTx = db
) {
  const offset = (input.page - 1) * input.limit;

  const rows = await dbClient
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
      close: instruments.latestClose,
      open: instruments.latestOpen,
      volume: instruments.latestVolume,
      changePct: instruments.latestChangePct,
    })
    .from(instruments)
    .where(buildStockFilters(input))
    .orderBy(...buildStockOrderBy(input.sortBy, input.sortDirection))
    .limit(input.limit)
    .offset(offset);

  return rows;
}

// Watchlist/Charts stock-selection picker only - always BSE, and always
// restricted to instruments with at least one stored 1D candle row, so a
// result can never open to an empty chart. Deliberately its own simple
// query rather than a mode of listStocks(): no provider hydration, no
// cache, no multi-exchange branching - just an indexed read, so typing
// in this picker never triggers a provider call. The EXISTS subquery
// reuses the existing (exchange, symbol, timeframe, time) unique index
// on candles (its leading three columns already cover this lookup) - no
// new index needed.
export async function searchChartEligibleBseStocks(
  input: { q: string; limit: number },
  dbClient: DbOrTx = db
) {
  const rows = await dbClient
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
      close: instruments.latestClose,
      open: instruments.latestOpen,
      volume: instruments.latestVolume,
      changePct: instruments.latestChangePct,
    })
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, "BSE"),
        eq(instruments.active, true),
        not(ilike(instruments.symbol, "0%")),
        or(
          ilike(instruments.symbol, `%${normalizeSymbol(input.q)}%`),
          ilike(instruments.name, `%${input.q.trim()}%`)
        ),
        sql`EXISTS (
          SELECT 1 FROM ${candles}
          WHERE ${candles.exchange} = ${instruments.exchange}
            AND ${candles.symbol} = ${instruments.symbol}
            AND ${candles.timeframe} = ${CANDLE_TIMEFRAME.day}
        )`
      )
    )
    .orderBy(asc(instruments.symbol))
    .limit(input.limit);

  return rows;
}

export async function readUnpricedStockSymbols(
  input: {
    q?: string;
    exchange: string;
    moveFilter?: MoveFilter;
    minVolume?: number;
  },
  limit: number,
  dbClient: DbOrTx = db
) {
  const rows = await dbClient
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(
      and(
        buildStockFilters({ ...input, includeUnpriced: true }),
        or(sql`${instruments.latestClose} IS NULL`, lte(instruments.latestClose, "0"))
      )
    )
    .orderBy(asc(instruments.symbol))
    .limit(limit);

  return rows.map((row) => row.symbol);
}

export function toStockListResponse(
  rows: Array<{
    symbol: string;
    name: string;
    exchange: string;
    close: string | null;
    changePct: string | null;
    volume: string | null;
    open: string | null;
  }>
) {
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    close: row.close === null ? undefined : Number(row.close),
    changePct: row.changePct === null ? undefined : Number(row.changePct),
    volume: row.volume === null ? undefined : Number(row.volume),
    open: row.open === null ? undefined : Number(row.open),
  }));
}

const MIN_FULL_MARKET_INSTRUMENTS = 1_000;
const LIST_STOCKS_CACHE_TTL_MS = 20_000;

function isRealtimePricedStockListExchange(exchange: string) {
  return exchange === "BSE" || exchange === "BSE_IDX";
}

function isPriceSortField(sortBy?: StockSortField) {
  return sortBy === "close" || sortBy === "changePct" || sortBy === "volume";
}

export async function listStocks(input: {
  q?: string;
  page: number;
  limit: number;
  sortBy?: StockSortField;
  sortDirection?: StockSortDirection;
  exchange?: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const cacheKey = [
    "listStocks",
    exchange,
    input.q ?? "",
    input.page,
    input.limit,
    input.sortBy ?? "",
    input.sortDirection ?? "",
    input.moveFilter ?? "",
    input.minVolume ?? "",
    input.includeUnpriced ? "includeUnpriced" : "",
  ].join(":");

  return getOrSetCache(cacheKey, LIST_STOCKS_CACHE_TTL_MS, () =>
    listStocksUncached({ ...input, exchange })
  );
}

async function listStocksUncached(input: {
  q?: string;
  page: number;
  limit: number;
  sortBy?: StockSortField;
  sortDirection?: StockSortDirection;
  exchange: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const exchange = input.exchange;
  const realtimePricedList = isRealtimePricedStockListExchange(exchange);
  const queryInput = realtimePricedList
    ? {
        ...input,
        exchange,
        includeUnpriced: true,
        moveFilter: undefined,
        minVolume: undefined,
        sortBy: isPriceSortField(input.sortBy) ? "symbol" : input.sortBy,
      }
    : { ...input, exchange };
  let rows = await readStockRows(queryInput);
  let total = await countStockRows(queryInput);

  const hydratedTotal = input.q?.trim()
    ? total
    : await countStockRows({ ...queryInput, includeUnpriced: true });

  if (!input.q?.trim() && hydratedTotal < MIN_FULL_MARKET_INSTRUMENTS) {
    await safeProviderAction("market-data.full-instrument-hydration", () =>
      hydrateDefaultMarketInstruments(exchange)
    );
    rows = await readStockRows(queryInput);
    total = await countStockRows(queryInput);
  }

  if (rows.length === 0) {
    if (input.q?.trim()) {
      await safeProviderAction("market-data.instrument-search", () =>
        syncProviderInstrumentSearch(input.q ?? "", exchange)
      );
      if (!queryInput.includeUnpriced && !realtimePricedList) {
        await safeProviderAction("market-data.search-price-hydration", async () => {
          const unpricedSymbols = await readUnpricedStockSymbols(
            queryInput,
            Math.min(input.limit, 12)
          );

          if (unpricedSymbols.length > 0) {
            await syncLatestDailyCandlesForSymbols(unpricedSymbols, exchange);
          }
        });
      }
    } else {
      await safeProviderAction("market-data.default-instrument-hydration", () =>
        hydrateDefaultMarketInstruments(exchange)
      );
    }
    rows = await readStockRows(queryInput);
    total = await countStockRows(queryInput);
  }

  if (
    !queryInput.includeUnpriced &&
    !realtimePricedList &&
    hydratedTotal > total &&
    total <= input.page * input.limit
  ) {
    const unpricedSymbols = await readUnpricedStockSymbols(queryInput, input.limit);

    if (unpricedSymbols.length > 0) {
      await safeProviderAction("market-data.next-page-price-hydration", () =>
        syncLatestDailyCandlesForSymbols(unpricedSymbols, exchange)
      );
      rows = await readStockRows(queryInput);
      total = await countStockRows(queryInput);
    }
  }

  const rowsMissingPrices = rows.filter((row) => row.close === null);
  if (realtimePricedList && rowsMissingPrices.length > 0) {
    await refreshLatestInstrumentStats(
      exchange,
      rowsMissingPrices.map((row) => row.symbol)
    );
    rows = await readStockRows(queryInput);
  }

  if (!queryInput.includeUnpriced && !realtimePricedList && rowsMissingPrices.length > 0) {
    await safeProviderAction("market-data.latest-candle-sync", () =>
      syncLatestDailyCandlesForSymbols(
        rowsMissingPrices.map((row) => row.symbol),
        exchange
      )
    );
    rows = await readStockRows(queryInput);
  }

  if (queryInput.includeUnpriced && !realtimePricedList && rowsMissingPrices.length > 0) {
    void safeProviderAction("market-data.visible-price-hydration", () =>
      syncLatestDailyCandlesForSymbols(
        rowsMissingPrices.slice(0, 8).map((row) => row.symbol),
        exchange
      )
    );
  }

  return {
    stocks: toStockListResponse(rows),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / input.limit)),
    },
  };
}
