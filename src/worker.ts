import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";

import { db, pool } from "./db/client";
import { syncJobs } from "./db/schema";
import {
  refreshAllLatestInstrumentPrices,
  syncProviderInstruments,
} from "./modules/market-data/market-data.service";
import { getRedisConnectionOptions } from "./modules/jobs/queues";
import {
  runWeeklyStrongBacktestBackfill,
  runWeeklyStrongBacktestHistoricalRebuild,
  syncWeeklyStrongBacktestIncremental,
} from "./modules/weekly-strong-backtest/weekly-strong-backtest.service";
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
        // Weekly incremental Weekly Strong backtest update - hooked onto
        // this existing 30-min-per-exchange job rather than a new
        // schedule. Idempotent (skips collections whose latest completed
        // week is already persisted) and only ever touches collections
        // already backfilled at least once, so this is a cheap no-op on
        // every run except the one where a new week has actually closed.
        if (exchange) {
          await syncWeeklyStrongBacktestIncremental(exchange).catch((error) => {
            logger.error(
              { exchange, message: error instanceof Error ? error.message : "Unknown error" },
              "Weekly Strong backtest incremental sync failed"
            );
          });
        }
        return result;
      });
    }

    if (job.name === JOB_NAMES.priceRefresh) {
      return runTrackedJob(job, () => refreshAllLatestInstrumentPrices(exchange));
    }

    if (job.name === JOB_NAMES.weeklyStrongBacktestBackfill) {
      const collectionId = typeof job.data.collectionId === "string" ? job.data.collectionId : undefined;
      const weeks = typeof job.data.weeks === "number" ? job.data.weeks : undefined;
      if (!collectionId) throw new Error("weeklyStrongBacktestBackfill job missing collectionId");
      return runTrackedJob(job, () => runWeeklyStrongBacktestBackfill({ collectionId, weeks }));
    }

    if (job.name === JOB_NAMES.weeklyStrongBacktestHistoricalRebuild) {
      const collectionId = typeof job.data.collectionId === "string" ? job.data.collectionId : undefined;
      if (!collectionId) throw new Error("weeklyStrongBacktestHistoricalRebuild job missing collectionId");
      return runTrackedJob(job, () => runWeeklyStrongBacktestHistoricalRebuild({ collectionId }));
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
