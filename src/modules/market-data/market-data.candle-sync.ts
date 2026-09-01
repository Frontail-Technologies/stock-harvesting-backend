import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { instruments, marketCollections } from "../../db/schema";
import { CANDLE_SOURCE, CANDLE_TIMEFRAME, DATA_PROVIDER_KEY, DEFAULT_EXCHANGE } from "../../shared/constants";
import { AppError, getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import { getActiveProviderAccessToken, getEligibleProviderAdapter, markProviderConnectionExpired } from "../data-provider/data-provider.service";
import { recordProviderFailure, recordProviderSuccess } from "../data-provider/data-provider-settings.service";
import { NSE_INDEX_EXCHANGE } from "../data-provider/adapters/zerodha-data-provider.adapter";
import { GLOBAL_DATAFEEDS_INDEX_EXCHANGE } from "../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import type { DataProviderAdapter, ProviderDailyCandle, ProviderSymbolDailyCandle } from "../data-provider/data-provider.types";
import { aggregateMonthlyCandles, aggregateWeeklyCandles } from "./candle-aggregation";
import { replaceCandlesAtomically, upsertCandles, type CandleUpsertInput } from "./market-data.candles";
import { getInstrumentsBySymbol, refreshLatestInstrumentStats } from "./market-data.instruments";
import { ensureInstrumentsForSymbols, getOrCreateInstrument } from "./market-data.instrument-sync";
import { getDateDaysAgo, getDefaultChartHistoryFromDate, getTodayDate } from "./market-data.dates";
import { deleteDashboardSnapshots } from "./dashboard-snapshot-store";

// Provider-backed candle synchronization/refresh orchestration: full-range
// backfill, latest-daily-candle sync, full-market price refresh, and the
// in-flight/cooldown single-flight wrappers getChartCandles calls into.
// Does not own the freshness decision itself (stays pure in the service) or
// metric-input/FX/listStocks orchestration - those call into this module.

async function safeProviderAction<T>(action: string, run: () => Promise<T>): Promise<T | null> {
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

const FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
const failedLatestCandleSyncAtBySymbol = new Map<string, number>();

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

export async function syncLatestDailyCandlesForSymbols(
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

// Clears every persisted Dashboard snapshot whose candle pool could have
// changed for this exchange - every active collection plus its
// index-exchange snapshot. Deletes only; the next read recomputes and
// re-persists on its own.
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

  // Authoritative invalidation trigger for the Dashboard's persisted
  // snapshots (not a fixed TTL) - deletes rather than recomputes inline, so
  // collections nobody opens between syncs never pay the recompute cost.
  // Only invalidates when a candle actually changed.
  if (refreshed > 0) {
    await invalidateDashboardSnapshotsForExchange(exchange);
  }

  return { symbolCount: symbols.length, refreshed };
}

const COMPLETED_CHART_BACKFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const chartBackfillPromises = new Map<string, Promise<unknown>>();
const completedChartBackfillAtByKey = new Map<string, number>();
const latestCandleRefreshPromises = new Map<string, Promise<unknown>>();

export function runChartBackfillOnce(input: {
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

// Concurrent chart requests for the same stale exchange+symbol collapse into
// one provider call instead of each firing its own - same in-flight-Promise
// pattern as runChartBackfillOnce above, keyed more loosely (just
// exchange:symbol, not also a date range) since this always targets "the
// latest candle", not a specific from/to window.
export function runLatestCandleRefreshOnce(input: { symbol: string; exchange: string }) {
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

export { safeProviderAction };
