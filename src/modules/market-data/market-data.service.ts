import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, not, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candles, instruments, marketCollections } from "../../db/schema";
import { getOrSetCache } from "../../shared/cache";
import { logger } from "../../shared/logger";
import { AppError, getErrorMessage } from "../../shared/errors";
import {
  CANDLE_SOURCE,
  CANDLE_TIMEFRAME,
  DATA_PROVIDER_KEY,
  DEFAULT_EXCHANGE,
  type CandleTimeframe,
} from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import {
  getActiveProviderAccessToken,
  getDataProviderAdapterForExchange,
  getEligibleProviderAdapter,
  getEodhdDataProviderAdapter,
  markProviderConnectionExpired,
} from "../data-provider/data-provider.service";
import {
  isProviderEnabled,
  recordProviderFailure,
  recordProviderSuccess,
} from "../data-provider/data-provider-settings.service";
import { NSE_INDEX_EXCHANGE } from "../data-provider/adapters/zerodha-data-provider.adapter";
import { GLOBAL_DATAFEEDS_INDEX_EXCHANGE } from "../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import type {
  DataProviderAdapter,
  ProviderDailyCandle,
  ProviderExchange,
  ProviderSymbolDailyCandle,
} from "../data-provider/data-provider.types";
import { aggregateMonthlyCandles, aggregateWeeklyCandles } from "./candle-aggregation";
import {
  filterMetricCandlesFrom,
  groupMetricCandlesBySymbol,
  deriveWeeklyMetricCandlesFromDaily,
  readCandleHistoryRange,
  readChartCandles,
  readMetricCandles,
  replaceCandlesAtomically,
  upsertCandles,
  type CandleUpsertInput,
  type MetricCandle,
} from "./market-data.candles";
import {
  applyLatestInstrumentStats,
  dedupeInstrumentUpsertInputs,
  getInstrumentsBySymbol,
  refreshLatestInstrumentStats,
  type InstrumentUpsertInput,
  type LatestInstrumentStat,
} from "./market-data.instruments";
import {
  ensureInstrumentsForSymbols,
  getOrCreateInstrument,
  hydrateDefaultMarketInstruments,
  syncProviderInstrumentSearch,
  syncProviderInstruments,
} from "./market-data.instrument-sync";
import {
  countStockRows,
  NSE_NORMAL_EQUITY_SYMBOL_PATTERN,
  readStockRows,
  readUnpricedStockSymbols,
  searchChartEligibleBseStocks,
  toStockListResponse,
  type StockSortDirection,
  type StockSortField,
} from "./market-data.stocks";
import {
  deleteDashboardSnapshots,
  readDashboardSnapshotWithMeta,
  RELATIVE_STRENGTH_SNAPSHOT_VERSION,
  writeDashboardSnapshot,
} from "./dashboard-snapshot-store";
import { getLatestExpectedTradingDay } from "./trading-calendar";
import type { MoveFilter } from "./market-data.schemas";
import {
  deriveScannerLookbackBars,
  evaluateWeeklyStrongLatest,
  evaluateWeeklyStrongSeries,
  excludeIncompleteTradingWeek,
  hasSufficientWeeklyStrongHistory,
  WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS,
} from "./weekly-strong-evaluator";

const CHART_HISTORY_YEARS = 30;
const FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
const MIN_FULL_MARKET_INSTRUMENTS = 1_000;
const RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT = 20;
const LIST_STOCKS_CACHE_TTL_MS = 20_000;
// Implementation now lives in market-data.stocks.ts; re-exported here so
// existing imports (e.g. market-collections.service.ts) keep working.
export { NSE_NORMAL_EQUITY_SYMBOL_PATTERN };
const failedLatestCandleSyncAtBySymbol = new Map<string, number>();
const chartBackfillPromises = new Map<string, Promise<unknown>>();
const completedChartBackfillAtByKey = new Map<string, number>();
const COMPLETED_CHART_BACKFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const latestCandleRefreshPromises = new Map<string, Promise<unknown>>();

function isRealtimePricedStockListExchange(exchange: string) {
  return exchange === "BSE" || exchange === "BSE_IDX";
}

function isPriceSortField(sortBy?: StockSortField) {
  return sortBy === "close" || sortBy === "changePct" || sortBy === "volume";
}

export type RelativeStrengthMetricRow = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
  close: number;
  volume: number;
  // THE single metric every relative-strength Dashboard widget
  // (Index/Sector/Industry/Stock) ranks and averages by - see
  // calculate55DayChange below. No other factor is folded into it.
  change55dPct: number;
};

export type { MetricCandle };

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

export type RelativeStrengthInstrumentInput = {
  symbol: string;
  name: string;
  exchange: string;
  sector?: string | null;
  industry?: string | null;
};

// Computes the single relative-strength metric (55-day change %, see
// calculate55DayChange) over an arbitrary instrument pool, for every
// instrument that has enough daily history - no top-N slicing here, unlike
// computeRelativeStrengthMetrics below. computeGroupRelativeStrength needs
// every qualifying row (to average per sector/industry), not just the
// global top N. Deliberately does not filter the pool by any other
// condition (e.g. a near-high breakout check) - every active instrument in
// the pool with enough history gets a row, matching "use the actual
// complete segment membership" for the 4 top Dashboard widgets. That is a
// deliberate difference from computeWeeklyStrongStocks below, which is a
// separate, unrelated breakout screen.
//
// This is THE expensive step (candle I/O per member) - exported so
// dashboard-snapshots.service.ts can call it exactly once per invalidation
// cycle and persist the result, instead of the Dashboard's read path
// (getCollectionRelativeStrength/getIndexRelativeStrength) each running it
// independently on every cache-cold request.
export async function computeAllRelativeStrengthMetrics(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string
): Promise<RelativeStrengthMetricRow[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  // Only daily candles are needed for a 55-session change - no weekly
  // fetch (weeklyFrom === dailyFrom collapses readDailyAndWeeklyMetricCandles's
  // internal fetch window to just the last 140 days instead of 5 years).
  const dailyFrom = getDateDaysAgo(140);
  const { dailyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom,
    weeklyFrom: dailyFrom,
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);

  return instrumentRows
    .map((instrument): RelativeStrengthMetricRow | null => {
      const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
      const latestDaily = dailyRows[dailyRows.length - 1];
      if (!latestDaily) return null;

      // A symbol with only a handful of candles (e.g. just synced
      // today's close, no real history yet) can't produce a genuine
      // 55-day reading - calculate55DayChange falls back to 0 when it
      // doesn't have enough bars, which would otherwise look identical to
      // a real "flat" score instead of "we don't have enough data yet".
      if (dailyRows.length <= 54) return null;

      const change55dPct = calculate55DayChange(dailyRows);

      return {
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        sector: instrument.sector ?? null,
        industry: instrument.industry ?? null,
        close: latestDaily.close,
        volume: latestDaily.volume,
        change55dPct,
      };
    })
    .filter((row): row is RelativeStrengthMetricRow => Boolean(row));
}

export async function computeRelativeStrengthMetrics(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string,
  limit: number
): Promise<RelativeStrengthMetricRow[]> {
  const allMetrics = await computeAllRelativeStrengthMetrics(instrumentRows, exchange);
  return pickTopRelativeStrengthRows(allMetrics, limit);
}

export type GroupRelativeStrengthRow = {
  label: string;
  score: number;
  memberCount: number;
};

// "Sector rotation" style ranking: instead of ranking individual stocks, rank
// the sector/industry categories themselves by the mean 55-day change % of
// their member stocks within this instrument pool. Requires instrumentRows
// to carry real sector/industry classification (from the sector-classification
// sync) - instruments with no classification yet are silently excluded
// rather than lumped into a misleading "unclassified" group.
// Pure/cheap (no candle I/O) - extracted so dashboard-snapshots.service.ts
// can group a STORED base metrics array
// the same way this always grouped a freshly-computed one. Averages the
// 55-day change % of every metric row sharing a sector/industry; a row
// with no classification for the requested groupBy is silently excluded
// (never lumped into a misleading "unclassified" group), matching the
// previous inline behavior exactly.
export function groupRelativeStrengthMetrics(
  allMetrics: RelativeStrengthMetricRow[],
  groupBy: "sector" | "industry",
  limit: number
): GroupRelativeStrengthRow[] {
  const groups = new Map<string, { total: number; count: number }>();

  for (const metric of allMetrics) {
    const key = groupBy === "sector" ? metric.sector : metric.industry;
    if (!key) continue;

    const group = groups.get(key) ?? { total: 0, count: 0 };
    group.total += metric.change55dPct;
    group.count += 1;
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([label, { total, count }]) => ({
      label,
      score: total / count,
      memberCount: count,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function computeGroupRelativeStrength(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string,
  groupBy: "sector" | "industry",
  limit: number
): Promise<GroupRelativeStrengthRow[]> {
  const allMetrics = await computeAllRelativeStrengthMetrics(instrumentRows, exchange);
  return groupRelativeStrengthMetrics(allMetrics, groupBy, limit);
}

// The Weekly Strong breakout screen. Unlike the relative-strength metrics
// above (which rank everything), this filters down to only the stocks
// that pass the qualification rule. See weekly-strong-evaluator.ts for the
// actual decision logic and constants - not restated here.

export type WeeklyStrongStockRow = {
  symbol: string;
  name: string;
  exchange: string;
  close: number;
  changePct: number;
  volume: number;
  sector: string | null;
  industry: string | null;
};

export async function computeWeeklyStrongStocks(
  instrumentRows: Array<{
    symbol: string;
    name: string;
    exchange: string;
    sector?: string | null;
    industry?: string | null;
  }>,
  exchange: string
): Promise<WeeklyStrongStockRow[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom: getDateYearsAgo(5),
    weeklyFrom: getDateYearsAgo(5),
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const weeklyCandlesBySymbol = groupMetricCandlesBySymbol(weeklyCandles);

  const rows: WeeklyStrongStockRow[] = [];

  for (const instrument of instrumentRows) {
    const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
    // Drops a trailing in-progress week before it can ever be evaluated as
    // "the latest completed week" - see excludeIncompleteTradingWeek. Only
    // the weekly leg needs this: a synced daily candle is complete the
    // moment it exists, but a weekly bucket keeps accumulating until its
    // own week ends.
    const weeklyRows = excludeIncompleteTradingWeek(
      weeklyCandlesBySymbol.get(instrument.symbol) ?? [],
      exchange
    );
    const latestDaily = dailyRows[dailyRows.length - 1];
    const latestWeekly = weeklyRows[weeklyRows.length - 1];
    if (!latestDaily || !latestWeekly) continue;

    // A near-empty window (e.g. just today's candle, no real history) has
    // its own "high" equal to roughly its own close, which trivially
    // passes a "near the high" check - that's a data gap, not a real
    // breakout. Skip symbols without a reasonably substantial sample.
    if (!hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRows.length)) continue;

    const decision = evaluateWeeklyStrongLatest(
      dailyRows.map((row) => row.close),
      weeklyRows.map((row) => row.close)
    );
    if (!decision.passes) continue;

    const previousDaily = dailyRows[dailyRows.length - 2];
    const changePct =
      previousDaily && previousDaily.close > 0
        ? ((latestDaily.close - previousDaily.close) * 100) / previousDaily.close
        : 0;

    rows.push({
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      close: latestDaily.close,
      changePct,
      volume: latestDaily.volume,
      sector: instrument.sector ?? null,
      industry: instrument.industry ?? null,
    });
  }

  return rows.sort((a, b) => b.changePct - a.changePct);
}

// Re-runs the same weekly-strong breakout check at every historical week
// over the backtest window, instead of just today, and counts how many pool
// members passed at each point - powers the persisted backtest backfill.
// Superseded computeWeeklyStrongStocksBacktest (count-only, live-computed
// on every Dashboard page load) - that function has been removed now that
// the Dashboard reads persisted weekly_strong_backtest_runs/_members
// instead of recomputing on read.
export const WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS = 250;
// Fetch window needs to cover both the oldest backtest week's own trailing
// evaluator lookback (see weekly-strong-evaluator.ts's own constants) AND
// the backtest range itself - comfortably over both at 10 years.
const WEEKLY_STRONG_BACKTEST_FETCH_YEARS = 10;

export type WeeklyStrongBacktestMemberRow = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
};

export type WeeklyStrongBacktestWeekMembers = {
  time: string;
  passing: WeeklyStrongBacktestMemberRow[];
};

// Fetches each pool member's full historical daily+weekly series exactly
// ONCE (not once per week evaluated), then runs the canonical evaluator's
// full-series pass in one call per instrument - this is the "don't fetch
// the same instrument history 250 separate times" requirement. The
// backfill job calls this directly and persists its output; nothing
// recomputes this on a Dashboard read.
export async function computeWeeklyStrongBacktestMembers(
  instrumentRows: Array<{
    symbol: string;
    name: string;
    exchange: string;
    sector?: string | null;
    industry?: string | null;
  }>,
  exchange: string,
  weeks: number = WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS
): Promise<WeeklyStrongBacktestWeekMembers[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom: getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS),
    weeklyFrom: getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS),
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const weeklyCandlesBySymbol = groupMetricCandlesBySymbol(weeklyCandles);

  const allWeeklyDates = new Set<string>();
  const membersByDate = new Map<string, WeeklyStrongBacktestMemberRow[]>();

  for (const instrument of instrumentRows) {
    const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
    // Same completed-week trim as computeWeeklyStrongStocks - persisted
    // history must never include today's still-forming week.
    const weeklyRows = excludeIncompleteTradingWeek(
      weeklyCandlesBySymbol.get(instrument.symbol) ?? [],
      exchange
    );
    // Same data-gap guard as computeWeeklyStrongStocks: a symbol with
    // barely any history can't produce a meaningful "near its own close high"
    // reading at any point in the backtest either.
    if (!hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRows.length)) continue;

    // Evaluated over this symbol's full available series (not pre-sliced
    // to the last `weeks`) - the trailing-window max at any index only
    // ever looks backward, so slicing the OUTPUT to the last `weeks` below
    // is equivalent to (and simpler/safer than) starting the walk
    // partway through, just with a few extra early-history decisions
    // computed and discarded.
    const seriesPoints = evaluateWeeklyStrongSeries(dailyRows, weeklyRows);

    for (const point of seriesPoints.slice(-weeks)) {
      allWeeklyDates.add(point.time);
      if (!point.passes) continue;

      const existing = membersByDate.get(point.time) ?? [];
      existing.push({
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        sector: instrument.sector ?? null,
        industry: instrument.industry ?? null,
      });
      membersByDate.set(point.time, existing);
    }
  }

  return [...allWeeklyDates]
    .sort()
    .slice(-weeks)
    .map((time) => ({ time, passing: membersByDate.get(time) ?? [] }));
}

export type SymbolBreakoutBacktestStats = {
  hitRatePct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  signalsGenerated: number;
  avgHoldingDays: number;
  largestWinnerPct: number;
  largestLoserPct: number;
};

type BreakoutTrade = { entryIndex: number; exitIndex: number; returnPct: number };

export type SymbolWeeklyStrongSeriesInput = {
  dailyRows: MetricCandle[];
  weeklyRows: MetricCandle[];
};

// Shared fetch+gate step for any per-symbol Weekly Strong evaluation - the
// Scanner's live near-high scan (scanner/rules/near-250-week-high.ts, via
// scanner.service.ts) and this file's own backtest below both need exactly
// this: the same daily+weekly series, the same completed-week trim, the
// same minimum-history gate. Factored out so the two call sites fetch and
// gate identically and can't silently diverge on WHAT data they evaluate -
// only computeSymbolBreakoutBacktest used to do this inline, and the live
// scan used to run its own, different (weekly-only) query entirely. See
// docs/KNOWN_ISSUES.md for the discrepancy this closes.
export async function getSymbolWeeklyStrongSeriesInput(
  symbol: string,
  exchange: string
): Promise<SymbolWeeklyStrongSeriesInput | null> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols: [normalizedSymbol],
    dailyFrom: getDefaultChartHistoryFromDate(),
    weeklyFrom: getDefaultChartHistoryFromDate(),
  });

  const dailyRows = groupMetricCandlesBySymbol(dailyCandles).get(normalizedSymbol) ?? [];
  // Same completed-week trim used everywhere else in the Weekly Strong
  // pipeline - the series must stop at the latest COMPLETED week, never
  // include today's still-forming week, live or historical.
  const weeklyRows = excludeIncompleteTradingWeek(
    groupMetricCandlesBySymbol(weeklyCandles).get(normalizedSymbol) ?? [],
    exchange
  );

  if (!hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRows.length)) {
    return null;
  }

  return { dailyRows, weeklyRows };
}

// Trade-by-trade backtest of the SAME two-condition breakout rule as
// computeWeeklyStrongStocks above, for one symbol over its full available
// history - this is what the Scanner's backtest stats overlay should be
// showing. It previously used a weekly-only simplification (see
// scanner/rules/near-250-week-high.ts) that silently dropped the daily
// confirmation condition, which is why its numbers didn't match "our logic".
export async function computeSymbolBreakoutBacktest(
  symbol: string,
  exchange: string,
  lookbackWeeks = WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS
): Promise<SymbolBreakoutBacktestStats | null> {
  const seriesInput = await getSymbolWeeklyStrongSeriesInput(symbol, exchange);
  if (!seriesInput) return null;
  const { dailyRows, weeklyRows } = seriesInput;

  // lookbackWeeks is caller-chosen (Scanner's own lookback multiplier) -
  // genuinely different orchestration from the fixed-window Weekly Strong
  // screen elsewhere, so this window-size formula (unchanged from before)
  // is preserved exactly rather than folded into the fixed defaults. Only
  // the shared per-bar decision logic is now common.
  const { dailyLookbackBars, weeklyLookbackBars } = deriveScannerLookbackBars(lookbackWeeks);
  const seriesPoints = evaluateWeeklyStrongSeries(dailyRows, weeklyRows, {
    dailyLookbackBars,
    weeklyLookbackBars,
  });
  // Re-aligned back to weeklyRows' own indices by time, since the series
  // evaluator (like the original loop here) can skip a leading stretch of
  // weeks with no corresponding daily data yet - those stay `false`,
  // matching the original matched[] array's default-false fill exactly.
  const passesByTime = new Map(seriesPoints.map((point) => [point.time, point.passes]));
  const matched: boolean[] = weeklyRows.map((row) => passesByTime.get(row.time) ?? false);

  const trades: BreakoutTrade[] = [];
  let entryIndex: number | null = null;

  for (let index = 0; index < weeklyRows.length; index++) {
    const isMatched = matched[index];
    const wasMatched = index > 0 && matched[index - 1];

    if (isMatched && !wasMatched) {
      entryIndex = index;
    } else if (!isMatched && wasMatched && entryIndex !== null) {
      trades.push(buildBreakoutTrade(entryIndex, index, weeklyRows));
      entryIndex = null;
    }
  }

  if (entryIndex !== null) {
    trades.push(buildBreakoutTrade(entryIndex, weeklyRows.length - 1, weeklyRows));
  }

  const signalsGenerated = trades.length;
  if (trades.length === 0) return null;

  const winners = trades.filter((trade) => trade.returnPct > 0);
  const losers = trades.filter((trade) => trade.returnPct <= 0);

  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equity *= 1 + trade.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  const grossProfit = winners.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.returnPct, 0));

  return {
    hitRatePct: (winners.length / trades.length) * 100,
    totalReturnPct: equity - 100,
    maxDrawdownPct,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    signalsGenerated,
    avgHoldingDays:
      trades.reduce((sum, trade) => sum + (trade.exitIndex - trade.entryIndex) * 7, 0) / trades.length,
    largestWinnerPct: Math.max(...trades.map((trade) => trade.returnPct)),
    largestLoserPct: Math.min(...trades.map((trade) => trade.returnPct)),
  };
}

function buildBreakoutTrade(
  entryIndex: number,
  exitIndex: number,
  rows: MetricCandle[]
): BreakoutTrade {
  const entryClose = rows[entryIndex].close;
  const exitClose = rows[exitIndex].close;
  return {
    entryIndex,
    exitIndex,
    returnPct: ((exitClose - entryClose) / entryClose) * 100,
  };
}

// All 4 dashboard cards rank by the same 55-day change % now (see
// RelativeStrengthMetricRow.change55dPct), so this is a single top-N
// selection rather than a union across 4 separately-ranked metrics.
// Exported so dashboard-snapshots.service.ts can slice a
// STORED base metrics array the same way this always sliced a freshly-
// computed one - pure/cheap (no candle I/O), safe to call on read.
export function pickTopRelativeStrengthRows(
  rows: RelativeStrengthMetricRow[],
  limit: number
) {
  return [...rows].sort((a, b) => b.change55dPct - a.change55dPct).slice(0, limit);
}

// Watchlist/Charts stock-selection picker (BSE-only, candle-eligible
// only). Implementation lives in market-data.stocks.ts; re-exported here
// so existing imports (e.g. market-data.routes.ts) keep working.
export { searchChartEligibleBseStocks };

export async function getChartHistoryRange(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  exchange?: string;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const range = await readCandleHistoryRange({
    symbol,
    exchange,
    timeframe: CANDLE_TIMEFRAME.day,
  });

  return {
    symbol,
    exchange,
    timeframe: CANDLE_TIMEFRAME.day,
    from: range?.from ?? null,
    to: range?.to ?? null,
  };
}

export async function getChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from?: string;
  to?: string;
  exchange?: string;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const from = input.from ?? getDefaultChartHistoryFromDate();
  const to = input.to ?? getTodayDate();

  let dailyRows = await readChartCandles({
    symbol,
    timeframe: CANDLE_TIMEFRAME.day,
    from: input.from,
    to: input.to,
    exchange,
  });

  const freshnessAction = decideChartCandleFreshnessAction(dailyRows, from, input.from, exchange);

  if (freshnessAction === "backfill") {
    await safeProviderAction("market-data.chart-candle-backfill", () =>
      runChartBackfillOnce({
        symbol,
        from,
        to,
        exchange,
      })
    );
    dailyRows = await readChartCandles({
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      from: input.from,
      to: input.to,
      exchange,
    });
  } else if (freshnessAction === "incremental-refresh") {
    // Only the latest row is out of date, so this does a targeted
    // incremental fetch (syncLatestDailyCandlesForSymbols, a ~14-day
    // window) instead of the full-range backfill above.
    await safeProviderAction("market-data.chart-candle-freshness-refresh", () =>
      runLatestCandleRefreshOnce({ symbol, exchange })
    );
    dailyRows = await readChartCandles({
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      from: input.from,
      to: input.to,
      exchange,
    });
  }

  if (dailyRows.length > 0) {
    return deriveChartCandlesFromDailyRows(dailyRows, input.timeframe).map(
      toChartCandleResponse
    );
  }

  if (input.timeframe !== CANDLE_TIMEFRAME.day) {
    const legacyRows = await readChartCandles({
      symbol,
      timeframe: input.timeframe,
      from: input.from,
      to: input.to,
      exchange,
    });
    if (legacyRows.length > 0) return legacyRows.map(toChartCandleResponse);
  }

  const runtimeRows = await safeProviderAction("market-data.chart-candle-runtime-fetch", () =>
    fetchRuntimeChartCandles({
      symbol,
      timeframe: input.timeframe,
      from,
      to,
      exchange,
    })
  );
  if (runtimeRows?.length) return runtimeRows;

  return [];
}

function deriveChartCandlesFromDailyRows(
  rows: Array<{
    time: string;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
  }>,
  timeframe: CandleTimeframe
) {
  const dailyRows = rows.map((row) => ({
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));

  return aggregateRuntimeChartCandles(dailyRows, timeframe);
}

function toChartCandleResponse(row: {
  time: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
}) {
  return {
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

async function fetchRuntimeChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  exchange: string;
}) {
  const adapter = await getEligibleProviderAdapter({
    exchange: input.exchange,
    capability: "historical_daily_candles",
  });
  if (!adapter) return [];

  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  const [instrument] = await db
    .select({
      instrumentToken: instruments.instrumentToken,
    })
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, input.exchange),
        eq(instruments.symbol, input.symbol)
      )
    )
    .limit(1);
  const instrumentToken =
    instrument?.instrumentToken ??
    (adapter.getInstrumentToken
      ? await adapter.getInstrumentToken(input.symbol, input.exchange)
      : input.symbol);

  let daily: ProviderDailyCandle[];
  try {
    daily = await adapter.fetchDailyCandles({
      accessToken,
      instrumentToken,
      symbol: input.symbol,
      from: input.from,
      to: input.to,
      exchangeCode: input.exchange,
    });
    void recordProviderSuccess(adapter.providerKey);
  } catch (error) {
    void recordProviderFailure(adapter.providerKey, error);
    throw error;
  }

  const chartRows = aggregateRuntimeChartCandles(daily, input.timeframe);
  return chartRows.map(toChartCandleResponse);
}

function aggregateRuntimeChartCandles(
  daily: ProviderDailyCandle[],
  timeframe: CandleTimeframe
) {
  if (timeframe === CANDLE_TIMEFRAME.day) return daily;
  if (timeframe === CANDLE_TIMEFRAME.week) return aggregateWeeklyCandles(daily);
  if (timeframe === CANDLE_TIMEFRAME.month) return aggregateMonthlyCandles(daily);

  return daily;
}

function hasLikelySplitDiscontinuity(
  rows: Array<{ close: string | number }>
) {
  for (let index = 1; index < rows.length; index++) {
    const previousClose = Number(rows[index - 1]?.close);
    const close = Number(rows[index]?.close);
    if (!Number.isFinite(previousClose) || !Number.isFinite(close)) continue;
    if (previousClose <= 0 || close <= 0) continue;

    const ratio = Math.max(previousClose, close) / Math.min(previousClose, close);
    if (ratio >= 4) return true;
  }

  return false;
}

// Charts performance/freshness audit (item 19) - fixes a confirmed bug
// found via real DB + live measurement: a normal chart open passes no
// explicit `from` (see getChartCandles's `input.from`), so `requestedFrom`
// here was always the internal 30-year default (CHART_HISTORY_YEARS) -
// and no BSE symbol in this system actually has 30 years of daily history
// (verified: TCS/RELIANCE/INFY all start 2007-01-02). That made
// `oldest > requestedFrom` unconditionally TRUE on every default request,
// triggering the expensive FULL multi-year backfill below on every single
// chart open regardless of freshness - not just once, forever - which is
// exactly what the comment on isLatestDailyCandleStale's own call site
// says should NOT happen ("once a symbol has any daily history, this is
// the only check that keeps serving it forever"). This check only makes
// sense at all when the caller explicitly asked for MORE history than is
// currently stored - it now only runs in that case; a normal, unbounded
// default request has no "did we backfill far enough back" question to
// ask in the first place, so it correctly falls through to the cheap
// isLatestDailyCandleStale incremental check instead.
function shouldBackfillRequestedHistory(
  rows: Array<{ time: string }>,
  requestedFrom: string,
  explicitFrom?: string
) {
  if (!explicitFrom || rows.length === 0) return false;

  const oldest = rows[0]?.time;
  if (!oldest) return false;

  return oldest > requestedFrom;
}

export function isLatestDailyCandleStale(
  rows: Array<{ time: string }>,
  exchange: string,
  at: Date = new Date()
) {
  const latest = rows[rows.length - 1]?.time;
  if (!latest) return false;
  return latest < getLatestExpectedTradingDay(exchange, at);
}

export type ChartCandleFreshnessAction = "backfill" | "incremental-refresh" | "none";

// The exact freshness/completeness decision getChartCandles makes before
// deciding whether (and how) to call the provider - extracted as its own
// pure function so the decision itself is directly testable without a live
// DB/provider (see market-data.freshness.test.ts). Order matters:
// missing/discontinuous/incomplete-history conditions take priority over
// mere staleness - a symbol with no usable history needs a full re-fetch,
// not just the latest few days.
export function decideChartCandleFreshnessAction(
  dailyRows: Array<{ time: string; close: string | number }>,
  from: string,
  requestedFrom: string | undefined,
  exchange: string
): ChartCandleFreshnessAction {
  if (
    dailyRows.length === 0 ||
    hasLikelySplitDiscontinuity(dailyRows) ||
    shouldBackfillRequestedHistory(dailyRows, from, requestedFrom)
  ) {
    return "backfill";
  }
  if (isLatestDailyCandleStale(dailyRows, exchange)) {
    return "incremental-refresh";
  }
  return "none";
}

// Concurrent chart requests for the same stale exchange+symbol collapse into
// one provider call instead of each firing its own - same in-flight-Promise
// pattern as runChartBackfillOnce above, keyed more loosely (just
// exchange:symbol, not also a date range) since this always targets "the
// latest candle", not a specific from/to window.
function runLatestCandleRefreshOnce(input: { symbol: string; exchange: string }) {
  const key = `${input.exchange}:${input.symbol}`;
  const existing = latestCandleRefreshPromises.get(key);
  if (existing) return existing;

  const promise = syncLatestDailyCandlesForSymbols([input.symbol], input.exchange).finally(
    () => {
      latestCandleRefreshPromises.delete(key);
    }
  );
  latestCandleRefreshPromises.set(key, promise);
  return promise;
}

function runChartBackfillOnce(input: {
  symbol: string;
  from: string;
  to: string;
  exchange: string;
}) {
  const key = `${input.exchange}:${input.symbol}:${input.from}:${input.to}`;
  const completedAt = completedChartBackfillAtByKey.get(key);
  if (
    completedAt !== undefined &&
    Date.now() - completedAt < COMPLETED_CHART_BACKFILL_COOLDOWN_MS
  ) {
    return Promise.resolve({ skipped: true });
  }

  const existing = chartBackfillPromises.get(key);
  if (existing) return existing;

  const promise = backfillDailyCandles(input)
    .then((result) => {
      completedChartBackfillAtByKey.set(key, Date.now());
      return result;
    })
    .finally(() => {
      chartBackfillPromises.delete(key);
    });
  chartBackfillPromises.set(key, promise);
  return promise;
}

async function deriveStoredCandlesForTimeframe(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  exchange: string;
}) {
  const dailyRows = await readChartCandles({
    symbol: input.symbol,
    timeframe: CANDLE_TIMEFRAME.day,
    from: input.from,
    to: input.to,
    exchange: input.exchange,
  });

  const firstDailyRow = dailyRows[0];
  if (!firstDailyRow?.instrumentId) return { inserted: 0 };
  const instrumentId = firstDailyRow.instrumentId;

  const sourceRows = dailyRows.map((row) => ({
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
  const aggregateRows =
    input.timeframe === CANDLE_TIMEFRAME.week
      ? aggregateWeeklyCandles(sourceRows)
      : input.timeframe === CANDLE_TIMEFRAME.month
        ? aggregateMonthlyCandles(sourceRows)
        : [];

  await upsertCandles(
    aggregateRows.map((candle) => ({
      instrumentId,
      exchange: input.exchange,
      symbol: input.symbol,
      timeframe: input.timeframe,
      source: CANDLE_SOURCE.derived,
      ...candle,
    }))
  );

  return { inserted: aggregateRows.length };
}

// Fetches daily+weekly candles for a symbol pool, and if a collection has
// never been viewed before (no candles synced for any member yet) triggers a
// best-effort one-time seed backfill for the first N symbols so the page
// isn't permanently empty - the same fallback pattern relative-strength
// metrics already rely on.
async function readDailyAndWeeklyMetricCandles(input: {
  exchange: string;
  symbols: string[];
  dailyFrom: string;
  weeklyFrom: string;
}) {
  const dailySourceFrom = input.dailyFrom < input.weeklyFrom ? input.dailyFrom : input.weeklyFrom;
  let sourceDailyCandles = await readMetricCandles({
    exchange: input.exchange,
    symbols: input.symbols,
    timeframe: CANDLE_TIMEFRAME.day,
    from: dailySourceFrom,
  });
  let dailyCandles = filterMetricCandlesFrom(sourceDailyCandles, input.dailyFrom);
  let weeklyCandles = deriveWeeklyMetricCandlesFromDaily(
    sourceDailyCandles,
    input.weeklyFrom
  );

  if (sourceDailyCandles.length === 0) {
    const legacyWeeklyCandles = await readMetricCandles({
      exchange: input.exchange,
      symbols: input.symbols,
      timeframe: CANDLE_TIMEFRAME.week,
      from: input.weeklyFrom,
    });

    if (legacyWeeklyCandles.length > 0) {
      return { dailyCandles, weeklyCandles: legacyWeeklyCandles };
    }

    const seedSymbols = input.symbols.slice(0, RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT);
    await safeProviderAction("market-data.relative-strength-seed-backfill", async () => {
      let seeded = 0;
      for (const symbol of seedSymbols) {
        try {
          await backfillDailyCandles({
            symbol,
            exchange: input.exchange,
            from: getDateYearsAgo(5),
            to: getTodayDate(),
          });
          seeded++;
        } catch (error) {
          logger.warn(
            {
              exchange: input.exchange,
              symbol,
              message: getErrorMessage(error, "Seed backfill failed"),
            },
            "Relative strength seed backfill failed for symbol"
          );
        }
      }
      return { symbols: seeded };
    });

    sourceDailyCandles = await readMetricCandles({
      exchange: input.exchange,
      symbols: input.symbols,
      timeframe: CANDLE_TIMEFRAME.day,
      from: dailySourceFrom,
    });
    dailyCandles = filterMetricCandlesFrom(sourceDailyCandles, input.dailyFrom);
    weeklyCandles = deriveWeeklyMetricCandlesFromDaily(
      sourceDailyCandles,
      input.weeklyFrom
    );
  }

  return { dailyCandles, weeklyCandles };
}

// THE canonical 55-day change calculation (item 1) - the ONLY formula any
// of the 4 relative-strength Dashboard widgets (Index/Sector/Industry/
// Stock) derives its ranking from. 55 daily observations inclusive of the
// latest close: the close 54 trading sessions before it, using actual
// daily candle rows (not calendar days), so weekends/holidays never skew
// the lookback.
// Exported for direct regression testing only (pure function, no other
// caller needs it outside this file) - see market-data.55-day-change.test.ts.
export const CHANGE_55D_LOOKBACK_BARS = 54;

export function calculate55DayChange(dailyRows: MetricCandle[]): number {
  const latest = dailyRows[dailyRows.length - 1];
  const base = dailyRows[dailyRows.length - 1 - CHANGE_55D_LOOKBACK_BARS];

  if (!latest || !base || base.close === 0) return 0;
  return ((latest.close - base.close) * 100) / base.close;
}

// Implementation lives in market-data.instrument-sync.ts; re-exported here
// so existing imports (admin.service.ts, worker.ts) keep working.
export { syncProviderInstruments };

export async function backfillDailyCandles(
  input: {
    symbol: string;
    from: string;
    to: string;
    exchange?: string;
  },
  dbClient: DbOrTx = db
) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;

  // Checked before touching anything (including instrument creation) - a
  // disabled/unconfigured provider must be a true no-op here, never a
  // reason to delete or alter existing stored candles.
  const adapter = await getEligibleProviderAdapter({
    exchange,
    capability: "historical_daily_candles",
  });
  if (!adapter) {
    return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 };
  }

  const instrument = await getOrCreateInstrument(symbol, exchange, dbClient);

  if (!instrument) {
    return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 };
  }

  // Everything that can fail for reasons outside our control (network,
  // vendor errors, rate limits) happens before we touch existing rows -
  // deleteCandlesForRefresh only runs once we already have validated
  // replacement data in hand, inside the transaction below.
  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  let daily: ProviderDailyCandle[];
  try {
    daily = await adapter.fetchDailyCandles({
      accessToken,
      instrumentToken: instrument.instrumentToken,
      symbol,
      from: input.from,
      to: input.to,
      exchangeCode: exchange,
    });
    void recordProviderSuccess(adapter.providerKey);
  } catch (error) {
    void recordProviderFailure(adapter.providerKey, error);
    throw error;
  }

  const weekly = aggregateWeeklyCandles(daily);
  const monthly = aggregateMonthlyCandles(daily);

  await replaceCandlesAtomically(dbClient, {
    instrumentId: instrument.id,
    exchange,
    symbol,
    from: input.from,
    to: input.to,
    daily,
    weekly,
    monthly,
  });

  // A denormalized read-cache refresh, not part of the replacement
  // invariant above - runs after commit so it reads the now-durable rows.
  // If this step fails, the candles are still correctly replaced; only the
  // instruments.latest* cache stays stale until the next sync.
  await refreshLatestInstrumentStats(exchange, [symbol], dbClient);

  return {
    insertedDaily: daily.length,
    insertedWeekly: weekly.length,
    insertedMonthly: monthly.length,
  };
}

// The atomic core of a candle-range replacement: delete the existing
// exchange/symbol/date-range across all 3 timeframes, then upsert the fresh
// daily/weekly/monthly rows - all inside one transaction, so a failure at
// any step (including a duplicate-key error surfaced from upsertCandles)
// rolls back the delete too, instead of leaving the range empty. Exported
// so it can be exercised directly against a fake DbOrTx in tests, without
// needing to also fake the provider-fetch layer that backfillDailyCandles
// wraps around it. Implementation lives in market-data.candles.ts;
// re-exported here so existing imports from this file keep working.
export { replaceCandlesAtomically };

// Backfills full price history for the small (~120), explicitly synced set
// of index instruments on one index exchange (NSE_IDX or BSE_IDX) - a
// deliberate, bounded admin action, not proactive bulk backfill for the
// whole market. Reuses backfillDailyCandles unchanged; it's already
// exchange-generic. Defaults to NSE_IDX to preserve existing callers.
export async function backfillIndexCandles(exchange: string = NSE_INDEX_EXCHANGE) {
  const indexInstruments = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const from = getDefaultChartHistoryFromDate();
  const to = new Date().toISOString().slice(0, 10);
  let backfilled = 0;
  const failedSymbols: string[] = [];

  // One slow/unhistoried index shouldn't sink backfill for the rest -
  // continue past a per-symbol failure and report it instead of aborting.
  for (const row of indexInstruments) {
    try {
      await backfillDailyCandles({ symbol: row.symbol, from, to, exchange });
      backfilled++;
    } catch (error) {
      failedSymbols.push(row.symbol);
      logger.warn(
        {
          exchange,
          symbol: row.symbol,
          message: getErrorMessage(error, "Backfill failed"),
        },
        "Index candle backfill failed for symbol"
      );
    }
  }

  return { indexCount: indexInstruments.length, backfilled, failedSymbols };
}

// Global (not collection-scoped) ranking of one index exchange's indices
// against each other - reuses computeAllRelativeStrengthMetrics unchanged,
// since ranking an index pool by the same combined score is exactly the
// same computation shape as ranking a stock pool; each index is just its
// own single row here, no grouping/averaging needed (unlike
// computeGroupRelativeStrength). Defaults to NSE_IDX to preserve existing
// callers; pass BSE_IDX for the BSE index box.
//
// This used to call computeRelativeStrengthMetrics (a live, uncached,
// years-of-candles computation) on EVERY request, unlike the
// collection-scoped RS surfaces which at least had a short in-process
// cache. Now reads a persisted snapshot (scope "index_exchange", keyed by
// the exchange code - indices aren't members of any market_collection, so
// there's no collectionId to key this by) and derives the limited/sorted
// view from it via pickTopRelativeStrengthRows - pure, no candle I/O. On a
// miss it computes once and persists before returning (the same
// exception/bootstrap path as the collection-scoped version above).
export async function getIndexRelativeStrength(
  limit: number,
  exchange: string = NSE_INDEX_EXCHANGE
): Promise<{ metrics: RelativeStrengthMetricRow[]; asOfDate: string }> {
  const cached = await readDashboardSnapshotWithMeta<RelativeStrengthMetricRow[]>(
    "index_exchange",
    exchange,
    "relative_strength"
  );
  if (cached && cached.evaluatorVersion === RELATIVE_STRENGTH_SNAPSHOT_VERSION) {
    return { metrics: pickTopRelativeStrengthRows(cached.payload, limit), asOfDate: cached.asOfDate };
  }

  const indexInstruments = await db
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
    })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const allMetrics = await computeAllRelativeStrengthMetrics(indexInstruments, exchange);
  const { asOfDate } = await writeDashboardSnapshot({
    scopeType: "index_exchange",
    scopeKey: exchange,
    metricType: "relative_strength",
    exchange,
    evaluatorVersion: RELATIVE_STRENGTH_SNAPSHOT_VERSION,
    payload: allMetrics,
  });
  return { metrics: pickTopRelativeStrengthRows(allMetrics, limit), asOfDate };
}

const SUPPORTED_EXCHANGES_CACHE_TTL_MS = 24 * 60 * 60_000;
const NSE_PROVIDER_EXCHANGE: ProviderExchange = {
  code: "NSE",
  name: "India (NSE)",
  currency: "INR",
  country: "India",
};
const GLOBAL_DATAFEEDS_PROVIDER_EXCHANGES: ProviderExchange[] = [
  {
    code: "BSE",
    name: "India (BSE)",
    currency: "INR",
    country: "India",
  },
  {
    code: "BSE_IDX",
    name: "India (BSE Indices)",
    currency: "INR",
    country: "India",
  },
];

// EODHD's exchange list is the source of truth for everything except NSE
// (Zerodha-only, not covered by EODHD at all - confirmed live). Cached for
// 24h since the underlying exchange metadata essentially never changes; the
// per-provider enabled checks below are what keep this responsive to admin
// data-provider toggles (data-provider-settings.service.ts invalidates this
// same cache prefix on every settings change, so the 24h TTL never actually
// delays a disable/enable from taking effect).
export async function listSupportedExchanges(): Promise<ProviderExchange[]> {
  return getOrSetCache("supportedExchanges", SUPPORTED_EXCHANGES_CACHE_TTL_MS, async () => {
    const eodhdAdapter = getEodhdDataProviderAdapter();
    const [nseEnabled, globalDatafeedsEnabled, eodhdEnabled] = await Promise.all([
      isProviderEnabled(DATA_PROVIDER_KEY.zerodha),
      isProviderEnabled(DATA_PROVIDER_KEY.globalDatafeeds),
      isProviderEnabled(eodhdAdapter.providerKey),
    ]);

    let eodhdExchanges: ProviderExchange[] = [];
    if (eodhdEnabled) {
      try {
        eodhdExchanges = (await eodhdAdapter.fetchExchanges?.()) ?? [];
      } catch (error) {
        logger.warn(
          { message: getErrorMessage(error, "Unknown provider error") },
          "Unable to fetch EODHD exchanges list"
        );
      }
    }

    const fixedExchanges = [
      ...(nseEnabled ? [NSE_PROVIDER_EXCHANGE] : []),
      ...(globalDatafeedsEnabled ? GLOBAL_DATAFEEDS_PROVIDER_EXCHANGES : []),
    ];
    const fixedCodes = new Set(fixedExchanges.map((exchange) => exchange.code));

    return [
      ...fixedExchanges,
      ...eodhdExchanges.filter((exchange) => !fixedCodes.has(exchange.code)),
    ];
  });
}

const FOREX_EXCHANGE = "FOREX";
const EXCHANGE_RATES_CACHE_TTL_MS = 15 * 60_000;

async function getLatestForexClose(pairSymbol: string): Promise<number | null> {
  const [row] = await db
    .select({ close: instruments.latestClose })
    .from(instruments)
    .where(and(eq(instruments.exchange, FOREX_EXCHANGE), eq(instruments.symbol, pairSymbol)))
    .limit(1);

  if (!row || row.close === null) return null;
  return Number(row.close);
}

// FOREX pairs are just regular instruments on the "FOREX" exchange (same
// pipeline as every other exchange) - no dedicated rates table. A pair with
// no candles yet gets a background sync kicked off and a neutral 1:1 rate
// for this request; the next call picks up the real rate once it lands.
async function ensureForexPairSyncing(pairSymbol: string) {
  void safeProviderAction("market-data.forex-pair-sync", () =>
    backfillDailyCandles({
      symbol: pairSymbol,
      exchange: FOREX_EXCHANGE,
      from: getDateDaysAgo(14),
      to: getTodayDate(),
    })
  );
}

export async function getUsdRate(currency: string): Promise<number> {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!normalizedCurrency || normalizedCurrency === "USD") return 1;

  const directPair = `${normalizedCurrency}USD`;
  const directClose = await getLatestForexClose(directPair);
  if (directClose !== null) return directClose;

  const inversePair = `USD${normalizedCurrency}`;
  const inverseClose = await getLatestForexClose(inversePair);
  if (inverseClose !== null && inverseClose > 0) return 1 / inverseClose;

  await ensureForexPairSyncing(directPair);
  return 1;
}

export async function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<number> {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (!from || !to || from === to) return amount;

  const [fromRate, toRate] = await Promise.all([getUsdRate(from), getUsdRate(to)]);
  if (toRate === 0) return amount;

  return (amount * fromRate) / toRate;
}

export async function listExchangeRates(): Promise<{ rates: Record<string, number>; base: "USD" }> {
  return getOrSetCache("exchangeRates", EXCHANGE_RATES_CACHE_TTL_MS, async () => {
    const exchanges = await listSupportedExchanges();
    const currencies = [
      ...new Set(exchanges.map((exchange) => exchange.currency.trim().toUpperCase()).filter(Boolean)),
    ];
    const rates: Record<string, number> = { USD: 1 };

    await Promise.all(
      currencies
        .filter((currency) => currency !== "USD")
        .map(async (currency) => {
          rates[currency] = await getUsdRate(currency);
        })
    );

    return { rates, base: "USD" as const };
  });
}

async function syncLatestDailyCandlesForSymbols(
  symbols: string[],
  exchange: string = DEFAULT_EXCHANGE
) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  const symbolsToSync = uniqueSymbols.filter(shouldRetryLatestCandleSync);
  if (symbolsToSync.length === 0) return { insertedDaily: 0 };

  const adapter = await getEligibleProviderAdapter({ exchange, capability: "latest_daily_candles" });
  if (!adapter || !adapter.fetchLatestDailyCandles) return { insertedDaily: 0 };

  await ensureInstrumentsForSymbols(symbolsToSync, exchange);
  const instrumentsBySymbol = await getInstrumentsBySymbol(symbolsToSync, exchange);
  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  let latestCandles: ProviderSymbolDailyCandle[];
  try {
    latestCandles =
      adapter.providerKey === DATA_PROVIDER_KEY.zerodha
        ? await fetchLatestDailyCandlesFromStoredInstruments({
            adapter,
            accessToken,
            exchange,
            symbols: symbolsToSync,
            instrumentsBySymbol,
          })
        : await adapter.fetchLatestDailyCandles({
            accessToken,
            symbols: symbolsToSync,
            exchangeCode: exchange,
          });
    void recordProviderSuccess(adapter.providerKey);
  } catch (error) {
    void recordProviderFailure(adapter.providerKey, error);
    throw error;
  }

  const candlesToUpsert: CandleUpsertInput[] = [];
  for (const candle of latestCandles) {
    const symbol = normalizeSymbol(candle.symbol);
    const instrument =
      instrumentsBySymbol.get(symbol) ?? (await getOrCreateInstrument(symbol, exchange));
    if (!instrument) continue;

    candlesToUpsert.push({
      instrumentId: instrument.id,
      exchange,
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      source: CANDLE_SOURCE.provider,
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  }

  await upsertCandles(candlesToUpsert);

  const syncedSymbols = new Set(latestCandles.map((candle) => normalizeSymbol(candle.symbol)));
  await refreshLatestInstrumentStats(exchange, [...syncedSymbols]);
  for (const symbol of symbolsToSync) {
    if (!syncedSymbols.has(symbol)) markLatestCandleSyncFailed(symbol);
  }

  return { insertedDaily: candlesToUpsert.length };
}

async function fetchLatestDailyCandlesFromStoredInstruments(input: {
  adapter: DataProviderAdapter;
  accessToken?: string;
  exchange: string;
  symbols: string[];
  instrumentsBySymbol: Map<string, typeof instruments.$inferSelect>;
}) {
  const adapter = input.adapter;
  const from = getDateDaysAgo(14);
  const to = getTodayDate();
  const latestCandles: ProviderSymbolDailyCandle[] = [];

  await runWithConcurrency(input.symbols, 8, async (symbol) => {
    const instrument = input.instrumentsBySymbol.get(symbol);
    if (!instrument?.instrumentToken) return;

    try {
      const dailyCandles = await adapter.fetchDailyCandles({
        accessToken: input.accessToken,
        instrumentToken: instrument.instrumentToken,
        symbol,
        from,
        to,
        exchangeCode: input.exchange,
      });
      const latest = dailyCandles[dailyCandles.length - 1];
      if (latest) latestCandles.push({ ...latest, symbol });
    } catch (error) {
      logger.debug(
        {
          exchange: input.exchange,
          symbol,
          message: getErrorMessage(error, "Unknown provider error"),
        },
        "Latest candle sync skipped symbol"
      );
    }
  });

  return latestCandles;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>
) {
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await run(item);
      }
    })
  );
}

const FULL_PRICE_REFRESH_CHUNK_SIZE = 200;

// Mirrors the frontend's own INDEX_EXCHANGE_BY_EQUITY_EXCHANGE
// (DashboardSegmentContent.tsx) - which virtual index exchange the Index
// card ranks for a given equity exchange. Only used here to know which
// "index_exchange" snapshot to invalidate alongside an equity exchange's
// own collection snapshots; an imprecise/missing mapping is harmless
// (worst case: one extra or one skipped invalidation, never wrong data).
const INDEX_EXCHANGE_BY_EQUITY_EXCHANGE: Record<string, string> = {
  NSE: NSE_INDEX_EXCHANGE,
  BSE: GLOBAL_DATAFEEDS_INDEX_EXCHANGE,
};

// The authoritative invalidation trigger: clears every
// persisted Dashboard snapshot whose underlying candle pool could have
// just changed for this equity exchange - every active collection on it,
// plus its corresponding index-exchange snapshot. Deletes only; the next
// actual Dashboard read for each affected scope recomputes and
// re-persists on its own (see dashboard-snapshots.service.ts /
// getIndexRelativeStrength above).
async function invalidateDashboardSnapshotsForExchange(exchange: string) {
  const collectionRows = await db
    .select({ id: marketCollections.id })
    .from(marketCollections)
    .where(and(eq(marketCollections.exchange, exchange), eq(marketCollections.active, true)));

  await Promise.all(collectionRows.map((row) => deleteDashboardSnapshots("collection", row.id)));

  const indexExchange = INDEX_EXCHANGE_BY_EQUITY_EXCHANGE[exchange];
  if (indexExchange) {
    await deleteDashboardSnapshots("index_exchange", indexExchange);
  }
}

// Unlike listStocks' lazy per-page hydration (which only ever touches
// symbols someone happened to request), this walks every active instrument
// for the exchange so gainers/decliners filtering and displayed prices stay
// complete table-wide, not just for pages a user has actually visited.
export async function refreshAllLatestInstrumentPrices(exchange: string = DEFAULT_EXCHANGE) {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const symbols = rows.map((row) => row.symbol);
  let refreshed = 0;

  for (let index = 0; index < symbols.length; index += FULL_PRICE_REFRESH_CHUNK_SIZE) {
    const chunk = symbols.slice(index, index + FULL_PRICE_REFRESH_CHUNK_SIZE);
    const result = await safeProviderAction("market-data.full-price-refresh", () =>
      syncLatestDailyCandlesForSymbols(chunk, exchange)
    );
    refreshed += result?.insertedDaily ?? 0;
  }

  // This is what actually changes the candle data the
  // Dashboard's persisted "current" snapshots (Relative Strength, Weekly
  // Strong - see dashboard-snapshot-store.ts) are derived from.
  // Invalidating them HERE, right after a real refresh, is the
  // AUTHORITATIVE trigger the report calls for - not a fixed TTL. Deletes
  // rather than recomputes inline: this runs as part of the existing
  // sync job (already a background/admin-triggered operation, not a
  // request a viewer is waiting on), so eagerly recomputing every
  // affected collection here - including ones nobody is currently
  // viewing, like the large auto-generated BSE-CLASSIFIED pool - would
  // waste real work. Deleting means the very next Dashboard read (for
  // whichever collection a real viewer actually opens) recomputes once
  // and re-persists; collections nobody opens between syncs never pay
  // the cost at all. Only invalidating when at least one candle actually
  // changed (`refreshed > 0`) avoids doing even that for a sync that
  // found nothing new (e.g. outside market hours, or every symbol
  // failed).
  if (refreshed > 0) {
    await invalidateDashboardSnapshotsForExchange(exchange);
  }

  return { symbolCount: symbols.length, refreshed };
}

function shouldRetryLatestCandleSync(symbol: string) {
  const lastFailedAt = failedLatestCandleSyncAtBySymbol.get(normalizeSymbol(symbol));
  return (
    lastFailedAt === undefined ||
    Date.now() - lastFailedAt > FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS
  );
}

function markLatestCandleSyncFailed(symbol: string) {
  failedLatestCandleSyncAtBySymbol.set(normalizeSymbol(symbol), Date.now());
}

async function safeProviderAction<T>(
  action: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    const safeMessage = getSafeProviderErrorMessage(error);
    logger.warn(
      {
        action,
        message: safeMessage,
        details: error instanceof AppError ? error.details : undefined,
      },
      "Market data provider action failed"
    );

    // A 401/403 from the provider means the stored token itself was
    // rejected (expired/revoked), not just this one request failing - the
    // connection's "connected" status would otherwise stay stale forever,
    // since nothing else ever re-checks it after the initial OAuth login.
    const details = error instanceof AppError ? (error.details as
      | { provider?: string; status?: number; message?: string }
      | undefined) : undefined;
    if (details?.provider && (details.status === 401 || details.status === 403)) {
      // Best-effort by design (a failure here shouldn't fail the request
      // that triggered it) - but silent before, so a broken expiry-marking
      // path could hide indefinitely. Now at least logged.
      void markProviderConnectionExpired(details.provider, details.message).catch(
        (markError: unknown) => {
          logger.warn(
            { provider: details.provider, message: getErrorMessage(markError) },
            "Failed to mark provider connection as expired"
          );
        }
      );
    }

    return null;
  }
}

function getSafeProviderErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown provider error";

  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const databaseCause = cause as {
      code?: unknown;
      detail?: unknown;
      hint?: unknown;
      message?: unknown;
    };
    const parts = [
      typeof databaseCause.message === "string" ? databaseCause.message : null,
      typeof databaseCause.code === "string" ? `code=${databaseCause.code}` : null,
      typeof databaseCause.detail === "string" ? databaseCause.detail : null,
      typeof databaseCause.hint === "string" ? databaseCause.hint : null,
    ].filter(Boolean);

    if (parts.length > 0) return parts.join(" | ");
  }

  const message = error.message.trim();
  if (!message) return error.name || "Unknown provider error";

  const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
  const sqlLikeMessage =
    message.includes("params:") ||
    message.includes("insert into") ||
    message.includes("on conflict") ||
    message.length > 500;

  if (!sqlLikeMessage) return message;

  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}...` : firstLine;
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getDefaultChartHistoryFromDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - CHART_HISTORY_YEARS);
  return date.toISOString().slice(0, 10);
}

function getDateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function getDateYearsAgo(years: number) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

// Implementations live in market-data.instruments.ts; re-exported here so
// existing imports from this file (including test files) keep working.
export {
  applyLatestInstrumentStats,
  dedupeInstrumentUpsertInputs,
  type InstrumentUpsertInput,
  type LatestInstrumentStat,
};

