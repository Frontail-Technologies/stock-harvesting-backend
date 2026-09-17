import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, pool } from "./db/client";
import { syncJobs } from "./db/schema";
import {
  refreshAllLatestInstrumentPrices,
  syncProviderInstruments,
} from "./modules/market-data/market-data.service";
import {
  refreshDailyCandles,
  findActiveSymbolsWithoutDailyCandles,
  syncDailyCandlesForActiveInstruments,
} from "./modules/market-data/market-data.candle-sync";
import { enqueueCandleBootstrapJobs, getRedisConnectionOptions } from "./modules/jobs/queues";
import {
  emitJobProgress,
  failBackgroundJobRun,
  finishBackgroundJobRunFromSummary,
  recordChartEnsureFreshResultIfNeeded,
  startBackgroundJobRun,
} from "./modules/jobs/background-job-runs.service";
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_NAMES, writeWorkerHeartbeat } from "./modules/jobs/worker-heartbeat";
import { prepareCollectionData } from "./modules/market-collections/market-collection-preparation.service";
import {
  runWeeklyStrongBacktestBackfill,
  runWeeklyStrongBacktestHistoricalRebuild,
  syncWeeklyStrongBacktestIncremental,
} from "./modules/weekly-strong-backtest/weekly-strong-backtest.generation";
import { BACKGROUND_JOB_TYPES, JOB_NAMES, JOB_STATUS, QUEUE_NAMES, type BackgroundJobType } from "./shared/constants";
import { env } from "./shared/env";
import { getErrorMessage, serializeError } from "./shared/errors";
import { logger } from "./shared/logger";
import {
  bullmqJobDurationSeconds,
  bullmqJobRunsTotal,
  safeInc,
} from "./shared/metrics/metrics";
import { startWorkerMetricsServer } from "./shared/metrics/worker-metrics-server";

const connection = getRedisConnectionOptions();

if (!connection) {
  logger.warn("REDIS_URL is not configured; worker did not start");
  process.exit(0);
}

if (env.METRICS_ENABLED) {
  startWorkerMetricsServer();
}

// Log-safe job context: never the whole job.data (can carry tokens on some
// job types) - only the identifying fields.
function jobLogContext(job: Job | undefined) {
  const data = (job?.data ?? {}) as Record<string, unknown>;
  return {
    jobId: job?.id,
    name: job?.name,
    syncJobId: typeof data.syncJobId === "string" ? data.syncJobId : undefined,
    exchange: typeof data.exchange === "string" ? data.exchange : undefined,
    collectionId: typeof data.collectionId === "string" ? data.collectionId : undefined,
    attemptsMade: job?.attemptsMade,
  };
}

async function runTrackedJob<T>(job: Job, run: () => Promise<T>): Promise<T> {
  const syncJobId = job.data.syncJobId as string | undefined;
  if (syncJobId) {
    await db
      .update(syncJobs)
      .set({ status: JOB_STATUS.running, updatedAt: new Date() })
      .where(eq(syncJobs.id, syncJobId));
  }

  const endTimer = bullmqJobDurationSeconds.startTimer({
    queue: QUEUE_NAMES.marketData,
    job_type: job.name,
  });

  try {
    const result = await run();
    if (syncJobId) {
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.completed,
          payload: result as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, syncJobId));
    }
    recordJobOutcome(endTimer, job.name, "success");
    return result;
  } catch (error) {
    if (syncJobId) {
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: getErrorMessage(error, "Job failed"),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, syncJobId));
    }
    recordJobOutcome(endTimer, job.name, "failed");
    // Structured record at the point of failure - the real exception (name,
    // message, code, cause), not just a string, and not the bare-Error `{}`
    // the queue-level "failed" handler used to emit.
    logger.error(
      { ...jobLogContext(job), err: serializeError(error) },
      "Job run failed",
    );
    throw error;
  }
}

async function runTrackedDailyCandleSync(exchange: string | undefined, jobType: BackgroundJobType) {
  const runId = await startBackgroundJobRun(jobType);
  try {
    const summary = await syncDailyCandlesForActiveInstruments(exchange, (progress) => {
      void emitJobProgress({ runId, jobType, ...progress });
    });
    await finishBackgroundJobRunFromSummary(runId, jobType, summary);
    return summary;
  } catch (error) {
    await failBackgroundJobRun(runId, jobType, getErrorMessage(error, "Job failed"));
    throw error;
  }
}

async function runTrackedChartEnsureFresh(symbol: string, exchange: string | undefined) {
  const result = await refreshDailyCandles({ symbol, exchange });
  await recordChartEnsureFreshResultIfNeeded(result, symbol, exchange ?? "");
  return result;
}

function recordJobOutcome(
  endTimer: (labels?: Record<string, string>) => number,
  jobType: string,
  outcome: string,
) {
  try {
    endTimer({ outcome });
    safeInc(bullmqJobRunsTotal, {
      queue: QUEUE_NAMES.marketData,
      job_type: jobType,
      outcome,
    });
  } catch {
    // Metrics must never break job execution.
  }
}

const worker = new Worker(
  QUEUE_NAMES.marketData,
  async (job) => {
    const exchange =
      typeof job.data.exchange === "string" ? job.data.exchange : undefined;

    if (job.name === JOB_NAMES.instrumentSync) {
      return runTrackedJob(job, async () => {
        const result = await syncProviderInstruments(exchange);
        await refreshAllLatestInstrumentPrices(exchange);
        if (exchange) {
          await syncWeeklyStrongBacktestIncremental(exchange).catch((error) => {
            logger.error(
              { exchange, message: getErrorMessage(error, "Unknown error") },
              "Weekly Strong backtest incremental sync failed",
            );
          });
        }
        return result;
      });
    }

    if (job.name === JOB_NAMES.priceRefresh) {
      return runTrackedJob(job, () =>
        refreshAllLatestInstrumentPrices(exchange),
      );
    }

    if (job.name === JOB_NAMES.dailyCandleSync) {
      const jobType =
        typeof job.data.jobType === "string"
          ? (job.data.jobType as BackgroundJobType)
          : BACKGROUND_JOB_TYPES.dailyCandlePostMarket;
      return runTrackedJob(job, () => runTrackedDailyCandleSync(exchange, jobType));
    }

    if (job.name === JOB_NAMES.chartCandleEnsureFresh) {
      const symbol =
        typeof job.data.symbol === "string" ? job.data.symbol : undefined;
      if (!symbol) throw new Error("chartCandleEnsureFresh job missing symbol");
      return runTrackedJob(job, () => runTrackedChartEnsureFresh(symbol, exchange));
    }

    if (job.name === JOB_NAMES.candleBootstrapReconcile) {
      return runTrackedJob(job, async () => {
        const targetExchange = exchange ?? "BSE";
        const symbols = await findActiveSymbolsWithoutDailyCandles(targetExchange);
        return enqueueCandleBootstrapJobs(targetExchange, symbols);
      });
    }

    if (job.name === JOB_NAMES.weeklyStrongBacktestBackfill) {
      const collectionId =
        typeof job.data.collectionId === "string"
          ? job.data.collectionId
          : undefined;
      const weeks =
        typeof job.data.weeks === "number" ? job.data.weeks : undefined;
      if (!collectionId)
        throw new Error(
          "weeklyStrongBacktestBackfill job missing collectionId",
        );
      return runTrackedJob(job, () =>
        runWeeklyStrongBacktestBackfill({ collectionId, weeks }),
      );
    }

    if (job.name === JOB_NAMES.weeklyStrongBacktestHistoricalRebuild) {
      const collectionId =
        typeof job.data.collectionId === "string"
          ? job.data.collectionId
          : undefined;
      if (!collectionId)
        throw new Error(
          "weeklyStrongBacktestHistoricalRebuild job missing collectionId",
        );
      return runTrackedJob(job, () =>
        runWeeklyStrongBacktestHistoricalRebuild({ collectionId }),
      );
    }

    if (job.name === JOB_NAMES.collectionPrepare) {
      const collectionId =
        typeof job.data.collectionId === "string"
          ? job.data.collectionId
          : undefined;
      const membershipVersionId =
        typeof job.data.membershipVersionId === "string"
          ? job.data.membershipVersionId
          : null;
      if (!collectionId)
        throw new Error("collectionPrepare job missing collectionId");
      return runTrackedJob(job, () =>
        prepareCollectionData(collectionId, membershipVersionId),
      );
    }

    throw new Error(`Unsupported job: ${job.name}`);
  },
  { connection },
);

const workerStartedAt = new Date().toISOString();

async function heartbeat() {
  try {
    const client = await worker.client;
    await writeWorkerHeartbeat(client, WORKER_NAMES.marketData, workerStartedAt);
  } catch (error) {
    logger.warn({ message: getErrorMessage(error, "Unknown error") }, "Failed to write worker heartbeat");
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), WORKER_HEARTBEAT_INTERVAL_MS);

logger.info({ startedAt: workerStartedAt, queue: QUEUE_NAMES.marketData }, "Market data worker started");

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Job completed");
});

worker.on("failed", (job, error) => {
  logger.error(
    {
      ...jobLogContext(job),
      failedReason: job?.failedReason,
      err: serializeError(error),
    },
    "Job failed",
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down worker");
  clearInterval(heartbeatTimer);
  await worker.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
