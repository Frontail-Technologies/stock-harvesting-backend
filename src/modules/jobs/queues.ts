import { Queue, QueueEvents } from "bullmq";

import {
  BACKGROUND_JOB_TYPES,
  JOB_NAMES,
  QUEUE_NAMES,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { registerBullmqJobsCollector } from "../../shared/metrics/metrics";

const BULLMQ_JOB_STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;

registerBullmqJobsCollector(async (gauge) => {
  const queue = getMarketDataQueue();
  if (!queue) return;

  const counts = await queue.getJobCounts(...BULLMQ_JOB_STATES);
  for (const state of BULLMQ_JOB_STATES) {
    gauge.set({ queue: QUEUE_NAMES.marketData, state }, counts[state] ?? 0);
  }
});

const REPEATABLE_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const CANDLE_BOOTSTRAP_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

let marketDataQueue: Queue | null = null;
let marketDataQueueEvents: QueueEvents | null = null;
let loggedConnectionError = false;
let loggedQueueEventsConnectionError = false;

export function getRedisConnectionOptions() {
  if (!env.REDIS_URL) return null;
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

const PRODUCER_CONNECT_TIMEOUT_MS = 3_000;

// Only the Worker's blocking commands (BRPOPLPUSH/BLMOVE) require maxRetriesPerRequest: null -
// this API process only ever enqueues/reads, so its connection can (and must) fail a command
// deterministically instead of retrying forever when Redis is configured but unreachable.
export function getProducerRedisConnectionOptions() {
  const base = getRedisConnectionOptions();
  if (!base) return null;
  return {
    ...base,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: PRODUCER_CONNECT_TIMEOUT_MS,
  };
}

export function getMarketDataQueue() {
  const connection = getProducerRedisConnectionOptions();
  if (!connection) return null;
  if (!marketDataQueue) {
    marketDataQueue = new Queue(QUEUE_NAMES.marketData, { connection });

    marketDataQueue.on("error", (error) => {
      if (loggedConnectionError) return;
      loggedConnectionError = true;
      logger.warn(
        {
          message:
            getErrorMessage(error, "Unknown queue error"),
        },
        "Market data queue Redis connection failed; job features degraded",
      );
    });
  }
  return marketDataQueue;
}

export function getMarketDataQueueEvents() {
  const connection = getRedisConnectionOptions();
  if (!connection) return null;
  if (!marketDataQueueEvents) {
    marketDataQueueEvents = new QueueEvents(QUEUE_NAMES.marketData, { connection });

    marketDataQueueEvents.on("error", (error) => {
      if (loggedQueueEventsConnectionError) return;
      loggedQueueEventsConnectionError = true;
      logger.warn(
        {
          message: getErrorMessage(error, "Unknown queue events error"),
        },
        "Market data queue events Redis connection failed; ensure-fresh bounded wait degraded",
      );
    });
  }
  return marketDataQueueEvents;
}

const ENQUEUE_TIMEOUT_MS = 5_000;

// Defense-in-depth on top of the producer's own finite maxRetriesPerRequest/connectTimeout above:
// this bounds the call so a down Redis fails fast and visibly instead of leaving a caller's
// DB-persisted status (queued/pending) stuck forever, even if ioredis's own failure is slower
// than expected. jobId makes the enqueue idempotent - a duplicate trigger for the same identity
// collapses into the existing job instead of running the same heavy work twice; removeOnComplete/
// removeOnFail ensure that identity is free again once the job is done, so a later legitimate
// Retry isn't blocked by a finished job still occupying the same id.
export async function addJobWithTimeout<T extends object>(
  queue: Queue,
  jobName: string,
  data: T,
  opts?: { jobId?: string; attempts?: number; backoff?: { type: "fixed" | "exponential"; delay: number } },
): Promise<void> {
  await Promise.race([
    queue.add(jobName, data, { removeOnComplete: true, removeOnFail: true, ...opts }).then(() => undefined),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out enqueueing "${jobName}" job after ${ENQUEUE_TIMEOUT_MS}ms - Redis may be unreachable`)),
        ENQUEUE_TIMEOUT_MS,
      );
    }),
  ]);
}

const INSTRUMENT_SYNC_SCHEDULER_PREFIX = "repeatable-instrument-sync-";
const BOOTSTRAP_RECONCILE_SCHEDULER_PREFIX = "repeatable-candle-bootstrap-reconcile-";
const DAILY_CANDLE_SYNC_SCHEDULER_PREFIX = "repeatable-daily-candle-sync-";

// Repeatable schedulers persist in Redis across deploys, so an exchange that
// stopped being a production exchange (e.g. retired NSE) would keep firing
// forever unless its scheduler is removed explicitly.
async function removeStaleSchedulers(queue: Queue, prefix: string, keepIds: Set<string>) {
  try {
    const schedulers = await queue.getJobSchedulers();
    for (const scheduler of schedulers) {
      const id = scheduler.id ?? scheduler.key;
      if (!id || !id.startsWith(prefix) || keepIds.has(id)) continue;
      await queue.removeJobScheduler(id);
      logger.info({ schedulerId: id }, "Removed stale repeatable scheduler");
    }
  } catch (error) {
    logger.warn(
      { prefix, message: getErrorMessage(error, "Unknown error") },
      "Failed to prune stale repeatable schedulers",
    );
  }
}

export async function scheduleRepeatableMarketDataSync(exchanges: string[]) {
  const queue = getMarketDataQueue();
  if (!queue) return;

  await removeStaleSchedulers(
    queue,
    INSTRUMENT_SYNC_SCHEDULER_PREFIX,
    new Set(exchanges.map((exchange) => `${INSTRUMENT_SYNC_SCHEDULER_PREFIX}${exchange}`)),
  );

  for (const exchange of exchanges) {
    try {
      await queue.add(
        JOB_NAMES.instrumentSync,
        { exchange },
        {
          jobId: `${INSTRUMENT_SYNC_SCHEDULER_PREFIX}${exchange}`,
          repeat: { every: REPEATABLE_SYNC_INTERVAL_MS },
        },
      );
    } catch (error) {
      logger.warn(
        {
          exchange,
          message: getErrorMessage(error, "Unknown error"),
        },
        "Failed to schedule repeatable market data sync",
      );
    }
  }
}

export async function enqueueCandleBootstrapJobs(exchange: string, symbols: string[]) {
  const queue = getMarketDataQueue();
  if (!queue || symbols.length === 0) return { queued: 0 };

  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  const jobs = normalized.map((symbol) => ({
    name: JOB_NAMES.chartCandleEnsureFresh,
    data: { symbol, exchange },
    opts: {
      jobId: `initial-candle-bootstrap-${exchange}-${symbol}`,
      removeOnComplete: true,
      removeOnFail: true,
    },
  }));

  const chunkSize = 100;
  for (let start = 0; start < jobs.length; start += chunkSize) {
    await queue.addBulk(jobs.slice(start, start + chunkSize));
  }
  return { queued: jobs.length };
}

export async function scheduleCandleBootstrapReconciliation(exchanges: string[]) {
  const queue = getMarketDataQueue();
  if (!queue) return;

  await removeStaleSchedulers(
    queue,
    BOOTSTRAP_RECONCILE_SCHEDULER_PREFIX,
    new Set(exchanges.map((exchange) => `${BOOTSTRAP_RECONCILE_SCHEDULER_PREFIX}${exchange}`)),
  );

  for (const exchange of exchanges) {
    try {
      await queue.add(
        JOB_NAMES.candleBootstrapReconcile,
        { exchange },
        {
          jobId: `${BOOTSTRAP_RECONCILE_SCHEDULER_PREFIX}${exchange}`,
          repeat: { every: CANDLE_BOOTSTRAP_RECONCILE_INTERVAL_MS },
        },
      );
    } catch (error) {
      logger.warn(
        { exchange, message: getErrorMessage(error, "Unknown error") },
        "Failed to schedule candle bootstrap reconciliation",
      );
    }
  }
}

export const DAILY_CANDLE_SYNC_TZ = "Asia/Kolkata";
const DAILY_CANDLE_SYNC_MORNING_CRON = "40 9 * * 1-5";
const DAILY_CANDLE_SYNC_POST_MARKET_CRON = "50 15 * * 1-5";
const DAILY_CANDLE_SYNC_RETRY_CRON = "0 17 * * 1-5";

export const DAILY_CANDLE_SYNC_SCHEDULES = [
  { suffix: "morning", pattern: DAILY_CANDLE_SYNC_MORNING_CRON, jobType: BACKGROUND_JOB_TYPES.dailyCandleMorning },
  {
    suffix: "post-market",
    pattern: DAILY_CANDLE_SYNC_POST_MARKET_CRON,
    jobType: BACKGROUND_JOB_TYPES.dailyCandlePostMarket,
  },
  { suffix: "retry", pattern: DAILY_CANDLE_SYNC_RETRY_CRON, jobType: BACKGROUND_JOB_TYPES.dailyCandleRetry },
] as const;

export async function scheduleRepeatableDailyCandleSync(exchanges: string[]) {
  const queue = getMarketDataQueue();
  if (!queue) {
    logger.warn("Market data queue unavailable; daily candle sync schedules were not registered");
    return [];
  }

  await removeStaleSchedulers(
    queue,
    DAILY_CANDLE_SYNC_SCHEDULER_PREFIX,
    new Set(
      exchanges.flatMap((exchange) =>
        DAILY_CANDLE_SYNC_SCHEDULES.map(
          (schedule) => `${DAILY_CANDLE_SYNC_SCHEDULER_PREFIX}${exchange}-${schedule.suffix}`,
        ),
      ),
    ),
  );

  let registered = 0;
  const registeredExchanges = new Set<string>();
  for (const exchange of exchanges) {
    for (const schedule of DAILY_CANDLE_SYNC_SCHEDULES) {
      try {
        await queue.add(
          JOB_NAMES.dailyCandleSync,
          { exchange, jobType: schedule.jobType },
          {
            jobId: `${DAILY_CANDLE_SYNC_SCHEDULER_PREFIX}${exchange}-${schedule.suffix}`,
            repeat: { pattern: schedule.pattern, tz: DAILY_CANDLE_SYNC_TZ },
          },
        );
        registered += 1;
        registeredExchanges.add(exchange);
      } catch (error) {
        logger.warn(
          {
            exchange,
            jobType: schedule.jobType,
            message: getErrorMessage(error, "Unknown error"),
          },
          "Failed to schedule repeatable daily candle sync",
        );
      }
    }
  }

  logger.info(
    { registered, exchanges, tz: DAILY_CANDLE_SYNC_TZ },
    "Daily candle sync schedules registered",
  );
  return [...registeredExchanges];
}

export async function getRepeatableDailyCandleSyncJobs() {
  const queue = getMarketDataQueue();
  if (!queue) return [];
  return queue.getJobSchedulers();
}

// Best-effort cleanup - the real safety net against a stale job acting on a deleted collection is prepareCollectionData's own no-op check, not this removal.
export async function removeQueuedCollectionPrepareJobs(collectionIds: string[]) {
  const queue = getMarketDataQueue();
  if (!queue || collectionIds.length === 0) return;

  const idsToRemove = new Set(collectionIds);
  try {
    const jobs = await queue.getJobs(["waiting", "delayed"]);
    await Promise.all(
      jobs
        .filter(
          (job) => job.name === JOB_NAMES.collectionPrepare && idsToRemove.has(job.data?.collectionId)
        )
        .map((job) => job.remove())
    );
  } catch (error) {
    logger.warn(
      { collectionIds, message: getErrorMessage(error, "Unknown error") },
      "Failed to remove queued collection preparation jobs"
    );
  }
}

const QUEUE_CLIENT_LOOKUP_TIMEOUT_MS = 3_000;

export async function getMarketDataQueueRedisClient() {
  const queue = getMarketDataQueue();
  if (!queue) return null;
  try {
    return await Promise.race([
      queue.client,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timed out resolving the market data queue Redis client")),
          QUEUE_CLIENT_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    logger.warn(
      { message: getErrorMessage(error, "Unknown error") },
      "Failed to resolve market data queue Redis client",
    );
    return null;
  }
}

export async function closeQueues() {
  await marketDataQueue?.close();
  await marketDataQueueEvents?.close();
}
