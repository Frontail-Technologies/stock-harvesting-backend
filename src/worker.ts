import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";

import { db, pool } from "./db/client";
import { syncJobs } from "./db/schema";
import {
  refreshAllLatestInstrumentPrices,
  syncProviderInstruments,
} from "./modules/market-data/market-data.service";
import { getRedisConnectionOptions } from "./modules/jobs/queues";
import { JOB_NAMES, JOB_STATUS, QUEUE_NAMES } from "./shared/constants";
import { logger } from "./shared/logger";

const connection = getRedisConnectionOptions();

if (!connection) {
  logger.warn("REDIS_URL is not configured; worker did not start");
  process.exit(0);
}

async function runTrackedJob<T>(job: Job, run: () => Promise<T>): Promise<T> {
  const syncJobId = job.data.syncJobId as string | undefined;
  if (syncJobId) {
    await db
      .update(syncJobs)
      .set({ status: JOB_STATUS.running, updatedAt: new Date() })
      .where(eq(syncJobs.id, syncJobId));
  }

  try {
    const result = await run();
    if (syncJobId) {
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: result as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(syncJobs.id, syncJobId));
    }
    return result;
  } catch (error) {
    if (syncJobId) {
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: error instanceof Error ? error.message : "Job failed",
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, syncJobId));
    }
    throw error;
  }
}

const worker = new Worker(
  QUEUE_NAMES.marketData,
  async (job) => {
    const exchange = typeof job.data.exchange === "string" ? job.data.exchange : undefined;

    if (job.name === JOB_NAMES.instrumentSync) {
      return runTrackedJob(job, async () => {
        const result = await syncProviderInstruments(exchange);
        await refreshAllLatestInstrumentPrices(exchange);
        return result;
      });
    }

    if (job.name === JOB_NAMES.priceRefresh) {
      return runTrackedJob(job, () => refreshAllLatestInstrumentPrices(exchange));
    }

    throw new Error(`Unsupported job: ${job.name}`);
  },
  { connection }
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Job completed");
});

worker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, name: job?.name, error }, "Job failed");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down worker");
  await worker.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
