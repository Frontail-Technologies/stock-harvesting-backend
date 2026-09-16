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
import {
  COMPLETED_CHART_BACKFILL_COOLDOWN_MS,
  FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS,
} from "./market-data.constants";
import {
  readCandleDatesInRange,
  readCandleHistoryRange,
  replaceCandlesAtomically,
  upsertCandles,
  type CandleUpsertInput,
} from "./market-data.candles";
import { getInstrumentsBySymbol, refreshLatestInstrumentStats } from "./market-data.instruments";
import { ensureInstrumentsForSymbols, getOrCreateInstrument } from "./market-data.instrument-sync";
import { getDateDaysAgo, getDefaultChartHistoryFromDate, getTodayDate } from "./market-data.dates";
import { planDailyCandleSync } from "./market-data.candle-sync-plan";
import { getLatestExpectedTradingDay } from "./trading-calendar";
import { deleteDashboardSnapshots } from "./dashboard-snapshot-store";
import {
  candleBackfillDurationSeconds,
  candleBackfillsTotal,
  candlesUpsertedTotal,
  latestCandleRefreshDurationSeconds,
  latestCandleRefreshRunsTotal,
  latestCandleRefreshSymbolsTotal,
  safeInc,
} from "../../shared/metrics/metrics";

// Provider-backed candle sync/refresh orchestration, plus the in-flight/cooldown single-flight wrappers getChartCandles calls into.

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

    // A 401/403 means the stored token was rejected - mark the connection expired so its status doesn't stay stale forever.
    const details = error instanceof AppError ? (error.details as
      | { provider?: string; status?: number; message?: string }
      | undefined) : undefined;
    if (details?.provider && (details.status === 401 || details.status === 403)) {
      // Best-effort - a failure here shouldn't fail the request that triggered it, but is still logged.
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
  const startedAt = Date.now();

  try {
    // A disabled/unconfigured provider must be a true no-op here, never a reason to delete or alter existing stored candles.
    const adapter = await getEligibleProviderAdapter({
      exchange,
      capability: "historical_daily_candles",
    });
    if (!adapter) {
      recordCandleBackfill(exchange, "success", startedAt);
      return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0, dailyCandles: [] };
    }

    const instrument = await getOrCreateInstrument(symbol, exchange, dbClient);

    if (!instrument) {
      recordCandleBackfill(exchange, "success", startedAt);
      return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0, dailyCandles: [] };
    }

    // Everything that can fail (network, vendor, rate limits) happens before existing rows are touched - deleteCandlesForRefresh only runs with validated replacement data in hand.
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

    // A denormalized read-cache refresh - if this fails, candles are still correctly replaced, only instruments.latest* stays stale until next sync.
    await refreshLatestInstrumentStats(exchange, [symbol], dbClient);

    recordCandleBackfill(exchange, "success", startedAt);
    safeInc(
      candlesUpsertedTotal,
      { exchange, operation: "historical_backfill" },
      daily.length + weekly.length + monthly.length
    );

    return {
      insertedDaily: daily.length,
      insertedWeekly: weekly.length,
      insertedMonthly: monthly.length,
      dailyCandles: daily,
    };
  } catch (error) {
    recordCandleBackfill(exchange, "failed", startedAt);
    throw error;
  }
}

function recordCandleBackfill(exchange: string, outcome: "success" | "failed" | "deduplicated", startedAt: number) {
  safeInc(candleBackfillsTotal, { exchange, outcome });
  try {
    candleBackfillDurationSeconds.observe({ exchange, outcome }, (Date.now() - startedAt) / 1000);
  } catch {
    // Metrics must never break the operation they observe.
  }
}

// Bounded concurrency for the index history backfill. GDF GetHistory is the
// flaky call (see the adapter's own retry note) and this runs one HTTP request
// per index over the WS, so keep the in-flight count small.
const INDEX_CANDLE_BACKFILL_CONCURRENCY = 4;

// Backfills daily (+ derived weekly/monthly) history for the explicitly synced
// index instrument set on ONE index exchange (e.g. BSE_IDX ~130 rows) - a
// bounded admin action, not a whole-market backfill and NOT the equity
// bootstrap path. Idempotent per symbol (replaceCandlesAtomically), failure
// isolated per symbol, bounded concurrency. `deps` is a test seam only.
export async function backfillIndexCandles(
  exchange: string = NSE_INDEX_EXCHANGE,
  deps: {
    backfill?: (input: { symbol: string; from: string; to: string; exchange: string }) => Promise<unknown>;
    concurrency?: number;
  } = {}
) {
  const backfill = deps.backfill ?? backfillDailyCandles;
  const concurrency = deps.concurrency ?? INDEX_CANDLE_BACKFILL_CONCURRENCY;

  const indexInstruments = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const from = getDefaultChartHistoryFromDate();
  const to = new Date().toISOString().slice(0, 10);
  let backfilled = 0;
  const failedSymbols: string[] = [];

  // One slow/unhistoried index shouldn't sink backfill for the rest - continue past a per-symbol failure and report it instead of aborting.
  await runWithConcurrency(indexInstruments, concurrency, async (row) => {
    try {
      await backfill({ symbol: row.symbol, from, to, exchange });
      backfilled += 1;
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
  });

  // The index Relative Strength snapshot (dashboard "Index Harvest") is keyed
  // ("index_exchange", <exchange code>) and is NOT reached by
  // invalidateDashboardSnapshotsForExchange (that maps an *equity* exchange to
  // its index). Without this, a freshly-backfilled index would keep serving a
  // stale/empty cached snapshot until an unrelated BSE equity price refresh
  // happened to clear it.
  if (backfilled > 0) {
    await deleteDashboardSnapshots("index_exchange", exchange);
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

// Mirrors the frontend's INDEX_EXCHANGE_BY_EQUITY_EXCHANGE - which index snapshot to invalidate alongside an equity exchange's own; an imprecise mapping is harmless.
const INDEX_EXCHANGE_BY_EQUITY_EXCHANGE: Record<string, string> = {
  NSE: NSE_INDEX_EXCHANGE,
  BSE: GLOBAL_DATAFEEDS_INDEX_EXCHANGE,
};

// Clears every persisted Dashboard snapshot whose candle pool could have changed - deletes only, the next read recomputes and re-persists on its own.
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

// Unlike listStocks' lazy per-page hydration, this walks every active instrument for the exchange so gainers/decliners stay complete table-wide.
export async function refreshAllLatestInstrumentPrices(exchange: string = DEFAULT_EXCHANGE) {
  const startedAt = Date.now();

  try {
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
      safeInc(latestCandleRefreshSymbolsTotal, { exchange, outcome: result ? "success" : "failed" }, chunk.length);
      if (result) {
        safeInc(candlesUpsertedTotal, { exchange, operation: "latest_refresh" }, result.insertedDaily);
      }
    }

    // Authoritative invalidation trigger for Dashboard snapshots (not a fixed TTL) - only invalidates when a candle actually changed.
    if (refreshed > 0) {
      await invalidateDashboardSnapshotsForExchange(exchange);
    }

    recordLatestCandleRefreshRun(exchange, "success", startedAt);
    return { symbolCount: symbols.length, refreshed };
  } catch (error) {
    recordLatestCandleRefreshRun(exchange, "failed", startedAt);
    throw error;
  }
}

function recordLatestCandleRefreshRun(exchange: string, outcome: "success" | "failed", startedAt: number) {
  safeInc(latestCandleRefreshRunsTotal, { exchange, outcome });
  try {
    latestCandleRefreshDurationSeconds.observe({ exchange, outcome }, (Date.now() - startedAt) / 1000);
  } catch {
    // Metrics must never break the operation they observe.
  }
}

export type DailyCandleSyncStatus =
  | "updated"
  | "repaired"
  | "already-current"
  | "bootstrap-required"
  | "provider-empty"
  | "failed";

export type DailyCandleSyncResult = {
  symbol: string;
  instrumentId: string | null;
  status: DailyCandleSyncStatus;
  insertedDaily: number;
  failedDates: string[];
};

// The manual-refresh and scheduled-sync entry points share this one function -
// range planning (planDailyCandleSync) and the write path (backfillDailyCandles)
// stay identical between both callers, no separate formulas.
export async function refreshDailyCandles(
  input: { symbol: string; exchange?: string },
  dbClient: DbOrTx = db
): Promise<DailyCandleSyncResult> {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;

  const instrument = await getOrCreateInstrument(symbol, exchange, dbClient);
  if (!instrument) {
    return { symbol, instrumentId: null, status: "provider-empty", insertedDaily: 0, failedDates: [] };
  }

  const history = await readCandleHistoryRange({
    instrumentId: instrument.id,
    timeframe: CANDLE_TIMEFRAME.day,
  });
  const latestStoredDate = history?.to ?? null;
  const latestExpectedTradingDate = getLatestExpectedTradingDay(exchange);
  const plan = planDailyCandleSync({ latestStoredDate, latestExpectedTradingDate });

  if (plan.kind === "bootstrap-required") {
    return { symbol, instrumentId: instrument.id, status: "bootstrap-required", insertedDaily: 0, failedDates: [] };
  }

  const datesBefore = await readCandleDatesInRange({
    instrumentId: instrument.id,
    timeframe: CANDLE_TIMEFRAME.day,
    from: plan.from,
    to: plan.to,
  });

  const result = await backfillDailyCandles({ symbol, exchange, from: plan.from, to: plan.to }, dbClient);

  if (result.dailyCandles.length === 0) {
    return { symbol, instrumentId: instrument.id, status: "provider-empty", insertedDaily: 0, failedDates: [] };
  }

  const datesAfter = await readCandleDatesInRange({
    instrumentId: instrument.id,
    timeframe: CANDLE_TIMEFRAME.day,
    from: plan.from,
    to: plan.to,
  });

  const failedDates = result.dailyCandles
    .map((candle) => candle.time)
    .filter((time) => !datesAfter.has(time));

  if (failedDates.length > 0) {
    logger.error({ exchange, symbol, failedDates }, "Daily candle sync persistence failure");
    return { symbol, instrumentId: instrument.id, status: "failed", insertedDaily: result.insertedDaily, failedDates };
  }

  const wasAlreadyFresh = latestStoredDate !== null && latestStoredDate >= latestExpectedTradingDate;
  const status: DailyCandleSyncStatus =
    datesAfter.size > datesBefore.size ? (wasAlreadyFresh ? "repaired" : "updated") : "already-current";

  return { symbol, instrumentId: instrument.id, status, insertedDaily: result.insertedDaily, failedDates: [] };
}

const DAILY_CANDLE_SYNC_CONCURRENCY = 8;

export type DailyCandleSyncFailureDetail = {
  instrumentId: string | null;
  symbol: string;
  reason: string;
};

export type DailyCandleSyncSummary = {
  processed: number;
  updated: number;
  repaired: number;
  alreadyCurrent: number;
  bootstrapRequired: number;
  providerEmpty: number;
  failed: number;
  failedSymbols: string[];
  failedDetails: DailyCandleSyncFailureDetail[];
};

// The routine post-market-close sync: every active instrument on the exchange
// gets the same last-stored-date incremental + bounded recent repair window
// (planDailyCandleSync) that refreshDailyCandles uses for a single symbol. One
// symbol failing never aborts the run - failures are isolated and reported.
const DAILY_CANDLE_SYNC_PROGRESS_BATCH_SIZE = 25;

export type DailyCandleSyncProgress = {
  processed: number;
  total: number;
  updated: number;
  repaired: number;
  failed: number;
};

export async function syncDailyCandlesForActiveInstruments(
  exchange: string = DEFAULT_EXCHANGE,
  onProgress?: (progress: DailyCandleSyncProgress) => void
): Promise<DailyCandleSyncSummary> {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const summary: DailyCandleSyncSummary = {
    processed: 0,
    updated: 0,
    repaired: 0,
    alreadyCurrent: 0,
    bootstrapRequired: 0,
    providerEmpty: 0,
    failed: 0,
    failedSymbols: [],
    failedDetails: [],
  };

  await runWithConcurrency(rows, DAILY_CANDLE_SYNC_CONCURRENCY, async (row) => {
    summary.processed += 1;
    try {
      const result = await refreshDailyCandles({ symbol: row.symbol, exchange });
      if (result.status === "updated") summary.updated += 1;
      else if (result.status === "repaired") summary.repaired += 1;
      else if (result.status === "already-current") summary.alreadyCurrent += 1;
      else if (result.status === "bootstrap-required") summary.bootstrapRequired += 1;
      else if (result.status === "provider-empty") summary.providerEmpty += 1;
      else {
        summary.failed += 1;
        summary.failedSymbols.push(row.symbol);
        summary.failedDetails.push({
          instrumentId: result.instrumentId,
          symbol: row.symbol,
          reason: result.failedDates.length > 0 ? `persistence gap: ${result.failedDates.join(",")}` : "sync failed",
        });
      }
    } catch (error) {
      summary.failed += 1;
      summary.failedSymbols.push(row.symbol);
      summary.failedDetails.push({
        instrumentId: null,
        symbol: row.symbol,
        reason: getErrorMessage(error, "Unknown error"),
      });
      logger.error(
        { exchange, symbol: row.symbol, message: getErrorMessage(error, "Unknown error") },
        "Daily candle sync failed for symbol"
      );
    }

    if (onProgress && (summary.processed % DAILY_CANDLE_SYNC_PROGRESS_BATCH_SIZE === 0 || summary.processed === rows.length)) {
      onProgress({
        processed: summary.processed,
        total: rows.length,
        updated: summary.updated,
        repaired: summary.repaired,
        failed: summary.failed,
      });
    }
  });

  if (summary.updated + summary.repaired > 0) {
    await invalidateDashboardSnapshotsForExchange(exchange);
  }

  return summary;
}

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
    safeInc(candleBackfillsTotal, { exchange: input.exchange, outcome: "deduplicated" });
    return Promise.resolve({ skipped: true });
  }

  const existing = chartBackfillPromises.get(key);
  if (existing) {
    safeInc(candleBackfillsTotal, { exchange: input.exchange, outcome: "deduplicated" });
    return existing;
  }

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

// Same in-flight-Promise pattern as runChartBackfillOnce, keyed more loosely (exchange:symbol only) since this always targets the latest candle.
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
