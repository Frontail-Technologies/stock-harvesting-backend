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

export function getMarketDataQueue() {
  const connection = getRedisConnectionOptions();
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
