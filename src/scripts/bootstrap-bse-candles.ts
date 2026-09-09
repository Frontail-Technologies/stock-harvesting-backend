import { and, eq } from "drizzle-orm";

import { db } from "../db/client";
import { instruments } from "../db/schema";
import { getErrorMessage } from "../shared/errors";
import { normalizeSymbol } from "../shared/normalize";
import { backfillDailyCandles } from "../modules/market-data/market-data.candle-sync";
import { findSymbolsNeedingHistoryBackfill } from "../modules/market-data/market-data.candles";
import { getDefaultChartHistoryFromDate, getTodayDate } from "../modules/market-data/market-data.dates";

export const EXCHANGE = "BSE";
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 10;
const AGGREGATE_PROGRESS_INTERVAL_MS = 30_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type InstrumentOutcome = "success" | "skipped" | "partial" | "failed";

export type InstrumentResult = {
  symbol: string;
  outcome: InstrumentOutcome;
  candles: number;
  durationMs: number;
  error?: string;
};

export type QueueItem = { symbol: string; needsBackfill: boolean };

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eqIndex)] = raw.slice(eqIndex + 1);
    }
  }
  return args;
}

export function resolveDate(raw: unknown, fallback: string, flagName: string): string {
  if (typeof raw !== "string") return fallback;
  if (!DATE_PATTERN.test(raw)) {
    throw new Error(`--${flagName} must use YYYY-MM-DD format.`);
  }
  return raw;
}

export function resolveConcurrency(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number(raw) : DEFAULT_CONCURRENCY;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(parsed), MAX_CONCURRENCY);
}

export function resolveLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  run: (item: T) => Promise<void>
) {
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length && !shouldStop()) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await run(item);
      }
    })
  );
}

function logProgress(position: number, total: number, result: InstrumentResult) {
  console.log(`[${position}/${total}] ${EXCHANGE}:${result.symbol}`);
  console.log(`status=${result.outcome}`);
  console.log(`candles=${result.candles}`);
  const durationLine = `duration=${(result.durationMs / 1000).toFixed(1)}s`;
  console.log(result.error ? `${durationLine} error="${result.error}"` : durationLine);
}

export async function processQueue(
  queue: QueueItem[],
  options: { from: string; to: string; concurrency: number; shouldStop: () => boolean; onProgress?: (completed: number) => void }
): Promise<InstrumentResult[]> {
  const results: InstrumentResult[] = [];
  let completed = 0;

  await runWithConcurrency(queue, options.concurrency, options.shouldStop, async (item) => {
    const position = ++completed;

    if (!item.needsBackfill) {
      const result: InstrumentResult = { symbol: item.symbol, outcome: "skipped", candles: 0, durationMs: 0 };
      results.push(result);
      logProgress(position, queue.length, result);
      options.onProgress?.(completed);
      return;
    }

    const itemStartedAt = Date.now();
    try {
      const backfillResult = await backfillDailyCandles({
        symbol: item.symbol,
        from: options.from,
        to: options.to,
        exchange: EXCHANGE,
      });
      const result: InstrumentResult = {
        symbol: item.symbol,
        outcome: backfillResult.insertedDaily > 0 ? "success" : "partial",
        candles: backfillResult.insertedDaily,
        durationMs: Date.now() - itemStartedAt,
      };
      results.push(result);
      logProgress(position, queue.length, result);
    } catch (error) {
      const result: InstrumentResult = {
        symbol: item.symbol,
        outcome: "failed",
        candles: 0,
        durationMs: Date.now() - itemStartedAt,
        error: getErrorMessage(error, "Unknown error"),
      };
      results.push(result);
      logProgress(position, queue.length, result);
    }
    options.onProgress?.(completed);
  });

  return results;
}

export function summarize(results: InstrumentResult[]) {
  return {
    total: results.length,
    success: results.filter((r) => r.outcome === "success").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    partial: results.filter((r) => r.outcome === "partial").length,
    failed: results.filter((r) => r.outcome === "failed"),
    candles: results.reduce((sum, r) => sum + r.candles, 0),
  };
}

let shuttingDown = false;
function requestShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal} - finishing in-flight instruments, no new ones will start.`);
}

async function main() {
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  const args = parseArgs(process.argv.slice(2));
  const from = resolveDate(args.from, getDefaultChartHistoryFromDate(), "from");
  const to = resolveDate(args.to, getTodayDate(), "to");
  const concurrency = resolveConcurrency(args.concurrency);
  const force = args.force === true;
  const limit = resolveLimit(args.limit);
  const onlySymbol = typeof args.symbol === "string" ? normalizeSymbol(args.symbol) : undefined;

  console.log(`Bootstrap range: ${from} to ${to}, concurrency=${concurrency}, force=${force}`);

  const allInstruments = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, EXCHANGE), eq(instruments.active, true)));
  console.log(`BSE instruments discovered: ${allInstruments.length}`);

  let selected = allInstruments;
  if (onlySymbol) selected = selected.filter((row) => row.symbol === onlySymbol);
  if (typeof limit === "number") selected = selected.slice(0, limit);
  console.log(`Selected for processing: ${selected.length}`);

  const needingBackfill = force
    ? new Set(selected.map((row) => row.symbol))
    : new Set(
        await findSymbolsNeedingHistoryBackfill({
          exchange: EXCHANGE,
          symbols: selected.map((row) => row.symbol),
          requiredFromDate: from,
        })
      );

  const queue: QueueItem[] = selected.map((row) => ({
    symbol: row.symbol,
    needsBackfill: needingBackfill.has(row.symbol),
  }));

  const startedAt = Date.now();
  let lastReported = 0;
  const aggregateInterval = setInterval(() => {
    console.log(`-- progress: ${lastReported}/${queue.length} completed --`);
  }, AGGREGATE_PROGRESS_INTERVAL_MS);
  aggregateInterval.unref();

  const results = await processQueue(queue, {
    from,
    to,
    concurrency,
    shouldStop: () => shuttingDown,
    onProgress: (completed) => {
      lastReported = completed;
    },
  });

  clearInterval(aggregateInterval);

  const summary = summarize(results);
  const durationSeconds = (Date.now() - startedAt) / 1000;

  console.log("\n=== Bootstrap summary ===");
  console.log(`Total: ${queue.length}`);
  console.log(`Processed: ${results.length}`);
  console.log(`Success: ${summary.success}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Partial: ${summary.partial}`);
  console.log(`Failed: ${summary.failed.length}`);
  console.log(`Candles inserted/upserted: ${summary.candles}`);
  console.log(`Duration: ${durationSeconds.toFixed(1)}s`);

  if (summary.failed.length > 0) {
    console.log("\nFailed instruments:");
    for (const result of summary.failed) {
      console.log(`  ${EXCHANGE}:${result.symbol} - ${result.error ?? "Unknown error"}`);
    }
  }

  if (shuttingDown) {
    console.log("\nStopped early due to shutdown signal - safe to rerun to resume.");
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
