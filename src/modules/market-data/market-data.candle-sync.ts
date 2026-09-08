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
import { replaceCandlesAtomically, upsertCandles, type CandleUpsertInput } from "./market-data.candles";
import { getInstrumentsBySymbol, refreshLatestInstrumentStats } from "./market-data.instruments";
import { ensureInstrumentsForSymbols, getOrCreateInstrument } from "./market-data.instrument-sync";
import { getDateDaysAgo, getDefaultChartHistoryFromDate, getTodayDate } from "./market-data.dates";
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
      return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 };
    }

    const instrument = await getOrCreateInstrument(symbol, exchange, dbClient);

    if (!instrument) {
      recordCandleBackfill(exchange, "success", startedAt);
      return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 };
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

// Backfills the small (~120) explicitly synced index instrument set on one index exchange - a bounded admin action, not whole-market backfill.
export async function backfillIndexCandles(exchange: string = NSE_INDEX_EXCHANGE) {
  const indexInstruments = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const from = getDefaultChartHistoryFromDate();
  const to = new Date().toISOString().slice(0, 10);
  let backfilled = 0;
  const failedSymbols: string[] = [];

  // One slow/unhistoried index shouldn't sink backfill for the rest - continue past a per-symbol failure and report it instead of aborting.
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
