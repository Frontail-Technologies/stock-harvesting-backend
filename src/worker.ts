import { Worker, type Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "./db/client";
import {
  startGdfSessionBroker,
  stopGdfSessionBroker,
} from "./modules/data-provider/adapters/global-datafeeds/global-datafeeds.session-broker";
import { syncJobs } from "./db/schema";
import {
  refreshAllLatestInstrumentPrices,
  syncProviderInstruments,
} from "./modules/market-data/market-data.service";
import {
  backfillIndexCandles,
  refreshDailyCandles,
  findActiveSymbolsWithoutDailyCandles,
  syncDailyCandlesForActiveInstruments,
} from "./modules/market-data/market-data.candle-sync";
import { syncSectorClassifications } from "./modules/market-data/sector-classification.service";
import { enqueueCandleBootstrapJobs, getRedisConnectionOptions } from "./modules/jobs/queues";
import { scheduleProductionMarketDataJobs } from "./modules/jobs/schedule-production-jobs";
import {
  finishLedgerCoverage,
  MarketDataLedgerRunNotClaimableError,
  startMarketDataLedgerReconciliation,
} from "./modules/jobs/market-data-job-ledger";
import { isInstrumentSyncExchange, isProductionExchange } from "./modules/market-data/market-data.universe";
import { getExchangeTodayIfTradingDay, getLatestExpectedTradingDay } from "./modules/market-data/trading-calendar";
import {
  emitJobProgress,
  failBackgroundJobRun,
  finishBackgroundJobRunFromSummary,
  recordChartEnsureFreshResultIfNeeded,
  recordScheduledJobRun,
  startBackgroundJobRun,
} from "./modules/jobs/background-job-runs.service";
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_NAMES, writeWorkerHeartbeat } from "./modules/jobs/worker-heartbeat";
import { prepareCollectionData } from "./modules/market-collections/market-collection-preparation.service";
import {
  runWeeklyStrongBacktestBackfill,
  runWeeklyStrongBacktestHistoricalRebuild,
} from "./modules/weekly-strong-backtest/weekly-strong-backtest.generation";
import { reconcileWeeklyStrongBacktests } from "./modules/weekly-strong-backtest/weekly-strong-backtest.reconciliation";
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
  let initialPayload: Record<string, unknown> = {};
  if (syncJobId) {
    const [syncJob] = await db.select({ payload: syncJobs.payload }).from(syncJobs).where(eq(syncJobs.id, syncJobId)).limit(1);
    initialPayload = syncJob?.payload ?? {};
    await db
      .update(syncJobs)
      .set({
        status: JOB_STATUS.running,
        payload: sql`jsonb_set(${syncJobs.payload}, '{progress}', '5'::jsonb, true)`,
        updatedAt: new Date(),
      })
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
          payload: { ...initialPayload, ...(result as Record<string, unknown>), progress: 100 },
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

// Records a job-table row for scheduled runs of jobs that otherwise leave no trace in Postgres.
function runRecorded<T>(job: Job, jobType: BackgroundJobType, exchange: string | undefined, run: () => Promise<T>) {
  return recordScheduledJobRun(
    { jobType, exchange, bullmqJobId: job.id, hasSyncJob: typeof job.data.syncJobId === "string" },
    run,
  );
}

async function runTrackedDailyCandleSync(
  exchange: string,
  jobType: BackgroundJobType,
  job: Job,
  options?: { ledgerRunId?: string; tradingDate?: string; symbols?: string[] },
) {
  const scheduledTradingDate = options?.tradingDate
    ?? getExchangeTodayIfTradingDay(exchange)
    ?? getLatestExpectedTradingDay(exchange);
  const coverageTradingDate = options?.tradingDate ?? getLatestExpectedTradingDay(exchange);
  let claimed: string;
  try {
    claimed = await startBackgroundJobRun(jobType, {
      exchange,
      bullmqJobId: job.id,
      ledgerRunId: options?.ledgerRunId,
      tradingDate: scheduledTradingDate,
    });
  } catch (error) {
    if (error instanceof MarketDataLedgerRunNotClaimableError) {
      logger.info({ exchange, jobType, tradingDate: scheduledTradingDate }, "Skipped a terminal market-data ledger run");
      return { skipped: true, reason: "ledger-run-terminal" };
    }
    throw error;
  }
  const runId = claimed;
  try {
    let progressWrites = Promise.resolve();
    const summary = await syncDailyCandlesForActiveInstruments(exchange, (progress) => {
      progressWrites = progressWrites.then(() => emitJobProgress({ runId, jobType, ...progress }));
    }, options?.symbols, coverageTradingDate);
    await progressWrites;
    await finishBackgroundJobRunFromSummary(runId, jobType, summary);
    await finishLedgerCoverage({
      runId,
      exchange,
      tradingDate: coverageTradingDate,
      coverageExemptSymbols: summary.providerEmptySymbols,
    });
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

function skippedNonProductionExchange(job: Job, exchange: string) {
  logger.info(
    { ...jobLogContext(job), exchange },
    "Skipped job for an exchange outside the production universe",
  );
  return { skipped: true, exchange };
}

// GDF allows one session per key: this worker owns it and the API relays through Redis.
startGdfSessionBroker("owner-candidate");

const worker = new Worker(
  QUEUE_NAMES.marketData,
  async (job) => {
    const exchange =
      typeof job.data.exchange === "string" ? job.data.exchange : undefined;

    // A job left in the queue for an exchange that is no longer part of the
    // production universe (e.g. retired NSE) is dropped, never executed.
    if (job.name === JOB_NAMES.instrumentSync) {
      if (!exchange) throw new Error("instrumentSync job missing exchange");
      if (!(await isInstrumentSyncExchange(exchange))) return skippedNonProductionExchange(job, exchange);
      return runTrackedJob(job, () => runRecorded(job, BACKGROUND_JOB_TYPES.instrumentSync, exchange, async () => {
        const result = await syncProviderInstruments(exchange);
        // A newly discovered exchange may only now have active instruments.
        void scheduleProductionMarketDataJobs();
        await refreshAllLatestInstrumentPrices(exchange);
        if (exchange) {
          await reconcileWeeklyStrongBacktests(exchange).catch((error) => {
            logger.error(
              { exchange, message: getErrorMessage(error, "Unknown error") },
              "Weekly Strong backtest incremental sync failed",
            );
          });
        }
        return result;
      }));
    }

    if (job.name === JOB_NAMES.priceRefresh) {
      if (!exchange) throw new Error("priceRefresh job missing exchange");
      if (!(await isProductionExchange(exchange))) return skippedNonProductionExchange(job, exchange);
      return runTrackedJob(job, () =>
        runRecorded(job, BACKGROUND_JOB_TYPES.priceRefresh, exchange, () => refreshAllLatestInstrumentPrices(exchange)),
      );
    }

    if (job.name === JOB_NAMES.sectorClassificationSync) {
      return runTrackedJob(job, () =>
        runRecorded(job, BACKGROUND_JOB_TYPES.sectorClassificationSync, undefined, () => syncSectorClassifications()),
      );
    }

    if (job.name === JOB_NAMES.indexCandleBackfill) {
      return runTrackedJob(job, () =>
        runRecorded(job, BACKGROUND_JOB_TYPES.indexCandleBackfill, exchange, () => backfillIndexCandles(exchange)),
      );
    }

    if (job.name === JOB_NAMES.dailyCandleSync) {
      if (!exchange) throw new Error("dailyCandleSync job missing exchange");
      if (!(await isProductionExchange(exchange))) return skippedNonProductionExchange(job, exchange);
      const jobType =
        typeof job.data.jobType === "string"
          ? (job.data.jobType as BackgroundJobType)
          : BACKGROUND_JOB_TYPES.dailyCandlePostMarket;
      return runTrackedJob(job, () => runTrackedDailyCandleSync(exchange, jobType, job));
    }

    if (job.name === JOB_NAMES.marketDataCatchUp) {
      if (!exchange) throw new Error("marketDataCatchUp job missing exchange");
      if (!(await isProductionExchange(exchange))) return skippedNonProductionExchange(job, exchange);
      const tradingDate = typeof job.data.tradingDate === "string" ? job.data.tradingDate : undefined;
      const ledgerRunId = typeof job.data.ledgerRunId === "string" ? job.data.ledgerRunId : undefined;
      const symbols = Array.isArray(job.data.symbols)
        ? job.data.symbols.filter((value: unknown): value is string => typeof value === "string")
        : undefined;
      if (!tradingDate || !ledgerRunId) throw new Error("marketDataCatchUp job missing ledger identity");
      return runTrackedJob(job, () => runTrackedDailyCandleSync(
        exchange,
        BACKGROUND_JOB_TYPES.dailyCandleCatchUp,
        job,
        { tradingDate, ledgerRunId, symbols },
      ));
    }

    if (job.name === JOB_NAMES.chartCandleEnsureFresh) {
      const symbol =
        typeof job.data.symbol === "string" ? job.data.symbol : undefined;
      if (!symbol) throw new Error("chartCandleEnsureFresh job missing symbol");
      return runTrackedJob(job, () => runTrackedChartEnsureFresh(symbol, exchange));
    }

    if (job.name === JOB_NAMES.candleBootstrapReconcile) {
      if (!exchange) throw new Error("candleBootstrapReconcile job missing exchange");
      if (!(await isProductionExchange(exchange))) return skippedNonProductionExchange(job, exchange);
      return runTrackedJob(job, () => runRecorded(job, BACKGROUND_JOB_TYPES.candleBootstrapReconcile, exchange, async () => {
        const targetExchange = exchange;
        const symbols = await findActiveSymbolsWithoutDailyCandles(targetExchange);
        return enqueueCandleBootstrapJobs(targetExchange, symbols);
      }));
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
      return runTrackedJob(job, async () => {
        const result = await runWeeklyStrongBacktestBackfill({ collectionId, weeks });
        if (job.data.automatic === true && exchange) await reconcileWeeklyStrongBacktests(exchange);
        return result;
      });
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
      return runTrackedJob(job, async () => {
        const result = await runWeeklyStrongBacktestHistoricalRebuild({ collectionId });
        if (job.data.automatic === true && exchange) await reconcileWeeklyStrongBacktests(exchange);
        return result;
      });
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
  { connection, concurrency: env.WORKER_CONCURRENCY },
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
startMarketDataLedgerReconciliation();
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
  await stopGdfSessionBroker();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
