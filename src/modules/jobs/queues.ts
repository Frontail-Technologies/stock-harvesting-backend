import { Queue } from "bullmq";

import {
  JOB_NAMES,
  QUEUE_NAMES,
  SUPPORTED_EXCHANGE_CODES,
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

let marketDataQueue: Queue | null = null;
let loggedConnectionError = false;

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
  opts?: { jobId?: string },
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

export async function scheduleRepeatableMarketDataSync() {
  const queue = getMarketDataQueue();
  if (!queue) return;

  for (const exchange of SUPPORTED_EXCHANGE_CODES) {
    try {
      await queue.add(
        JOB_NAMES.instrumentSync,
        { exchange },
        {
          jobId: `repeatable-instrument-sync-${exchange}`,
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

export async function closeQueues() {
  await marketDataQueue?.close();
}
