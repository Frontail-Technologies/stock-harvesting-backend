import { Queue } from "bullmq";

import {
  JOB_NAMES,
  QUEUE_NAMES,
  SUPPORTED_EXCHANGE_CODES,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { logger } from "../../shared/logger";

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
            error instanceof Error ? error.message : "Unknown queue error",
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
          message: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to schedule repeatable market data sync",
      );
    }
  }
}

export async function closeQueues() {
  await marketDataQueue?.close();
}
