import { Counter, Gauge, Histogram } from "prom-client";

import { pool } from "../../db/client";
import { metricsRegistry, METRICS_PREFIX } from "./metrics.registry";

const HTTP_DURATION_BUCKETS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const LONG_OPERATION_DURATION_BUCKETS = [
  1, 5, 10, 30, 60, 120, 300, 600, 1200, 3600,
];

export const httpRequestsTotal = new Counter({
  name: `${METRICS_PREFIX}http_requests_total`,
  help: "Total HTTP requests handled by the API process.",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: `${METRICS_PREFIX}http_request_duration_seconds`,
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route"] as const,
  buckets: HTTP_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

export const collectionPreparationsTotal = new Counter({
  name: `${METRICS_PREFIX}collection_preparations_total`,
  help: "Collection data preparation runs, by final outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

export const collectionPreparationDurationSeconds = new Histogram({
  name: `${METRICS_PREFIX}collection_preparation_duration_seconds`,
  help: "Collection data preparation run duration in seconds.",
  labelNames: ["outcome"] as const,
  buckets: LONG_OPERATION_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

export const collectionPreparationMembersTotal = new Counter({
  name: `${METRICS_PREFIX}collection_preparation_members_total`,
  help: "Collection members classified during preparation, by history availability.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const collectionsByPreparationStatus = new Gauge({
  name: `${METRICS_PREFIX}collections_by_preparation_status`,
  help: "Current count of market_collections rows per preparationStatus.",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
  async collect() {
    await refreshCollectionsByPreparationStatusImpl?.(this);
  },
});

let refreshCollectionsByPreparationStatusImpl:
  | ((gauge: Gauge<"status">) => Promise<void>)
  | null = null;
export function registerCollectionsByPreparationStatusCollector(
  impl: (gauge: Gauge<"status">) => Promise<void>,
) {
  refreshCollectionsByPreparationStatusImpl = impl;
}

export const candleBackfillsTotal = new Counter({
  name: `${METRICS_PREFIX}candle_backfills_total`,
  help: "Historical candle backfill attempts, by exchange and outcome.",
  labelNames: ["exchange", "outcome"] as const,
  registers: [metricsRegistry],
});

export const candleBackfillDurationSeconds = new Histogram({
  name: `${METRICS_PREFIX}candle_backfill_duration_seconds`,
  help: "Historical candle backfill duration in seconds.",
  labelNames: ["exchange", "outcome"] as const,
  buckets: LONG_OPERATION_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

export const candlesUpsertedTotal = new Counter({
  name: `${METRICS_PREFIX}candles_upserted_total`,
  help: "Candle rows written, by exchange and operation.",
  labelNames: ["exchange", "operation"] as const,
  registers: [metricsRegistry],
});

export const latestCandleRefreshRunsTotal = new Counter({
  name: `${METRICS_PREFIX}latest_candle_refresh_runs_total`,
  help: "Full-universe latest-candle refresh runs, by exchange and outcome.",
  labelNames: ["exchange", "outcome"] as const,
  registers: [metricsRegistry],
});

export const latestCandleRefreshDurationSeconds = new Histogram({
  name: `${METRICS_PREFIX}latest_candle_refresh_duration_seconds`,
  help: "Full-universe latest-candle refresh duration in seconds.",
  labelNames: ["exchange", "outcome"] as const,
  buckets: LONG_OPERATION_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

export const latestCandleRefreshSymbolsTotal = new Counter({
  name: `${METRICS_PREFIX}latest_candle_refresh_symbols_total`,
  help: "Symbols processed by the latest-candle refresh, by exchange and outcome.",
  labelNames: ["exchange", "outcome"] as const,
  registers: [metricsRegistry],
});

export const backtestRunsTotal = new Counter({
  name: `${METRICS_PREFIX}backtest_runs_total`,
  help: "Weekly Strong backtest generator invocations, by type and outcome.",
  labelNames: ["type", "outcome"] as const,
  registers: [metricsRegistry],
});

export const backtestDurationSeconds = new Histogram({
  name: `${METRICS_PREFIX}backtest_duration_seconds`,
  help: "Weekly Strong backtest generator duration in seconds.",
  labelNames: ["type", "outcome"] as const,
  buckets: LONG_OPERATION_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

export const backtestWeeksTotal = new Counter({
  name: `${METRICS_PREFIX}backtest_weeks_total`,
  help: "Backtest weeks generated, by type.",
  labelNames: ["type"] as const,
  registers: [metricsRegistry],
});

let refreshBullmqJobsImpl:
  | ((gauge: Gauge<"queue" | "state">) => Promise<void>)
  | null = null;
export function registerBullmqJobsCollector(
  impl: (gauge: Gauge<"queue" | "state">) => Promise<void>,
) {
  refreshBullmqJobsImpl = impl;
}

export const bullmqJobs = new Gauge({
  name: `${METRICS_PREFIX}bullmq_jobs`,
  help: "Current BullMQ job counts, by queue and state.",
  labelNames: ["queue", "state"] as const,
  registers: [metricsRegistry],
  async collect() {
    await refreshBullmqJobsImpl?.(this);
  },
});

export const bullmqJobRunsTotal = new Counter({
  name: `${METRICS_PREFIX}bullmq_job_runs_total`,
  help: "BullMQ job executions, by queue, job type, and outcome.",
  labelNames: ["queue", "job_type", "outcome"] as const,
  registers: [metricsRegistry],
});

export const bullmqJobDurationSeconds = new Histogram({
  name: `${METRICS_PREFIX}bullmq_job_duration_seconds`,
  help: "BullMQ job execution duration in seconds.",
  labelNames: ["queue", "job_type", "outcome"] as const,
  buckets: LONG_OPERATION_DURATION_BUCKETS,
  registers: [metricsRegistry],
});

// Provider request metrics deliberately not added - see docs/OBSERVABILITY.md "Deferred this phase" for why the boundary doesn't cleanly expose both labels.

export const dbConnections = new Gauge({
  name: `${METRICS_PREFIX}db_connections`,
  help: "Postgres connection pool state for this process (application-level, not server-side).",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
  collect() {
    this.set({ state: "total" }, pool.totalCount);
    this.set({ state: "idle" }, pool.idleCount);
    this.set({ state: "waiting" }, pool.waitingCount);
  },
});

export async function observeDuration<T>(
  histogram: Histogram<string>,
  labels: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const endTimer = histogram.startTimer(labels);
  try {
    return await run();
  } finally {
    try {
      endTimer();
    } catch {}
  }
}

export function safeInc(
  counter: Counter<string>,
  labels: Record<string, string>,
  value = 1,
) {
  try {
    counter.inc(labels, value);
  } catch {}
}
