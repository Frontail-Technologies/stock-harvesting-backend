import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../../db/client";
import { backgroundJobRuns } from "../../db/schema";
import {
  BACKGROUND_JOB_RUN_STATUS,
  BACKGROUND_JOB_TYPES,
  SCHEDULED_DAILY_CANDLE_SYNC_JOB_TYPES,
  type BackgroundJobType,
} from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import type { DailyCandleSyncFailureDetail, DailyCandleSyncSummary } from "../market-data/market-data.candle-sync";
import { getLatestExpectedTradingDay } from "../market-data/trading-calendar";
import { publishRealtimeEvent } from "./realtime-events";
import { claimMarketDataLedgerRun } from "./market-data-job-ledger";

const FAILED_SYMBOLS_METADATA_CAP = 25;
const RECENT_JOB_RUNS_DEFAULT_LIMIT = 25;

export async function startBackgroundJobRun(
  jobType: BackgroundJobType,
  ledger?: { exchange: string; bullmqJobId?: string; ledgerRunId?: string; tradingDate?: string },
) {
  const startedAt = new Date();
  const row = ledger
    ? { id: (await claimMarketDataLedgerRun({ jobType, ...ledger })).runId }
    : (await db
        .insert(backgroundJobRuns)
        .values({ jobType, status: BACKGROUND_JOB_RUN_STATUS.running, startedAt })
        .returning({ id: backgroundJobRuns.id }))[0];

  void publishRealtimeEvent({
    kind: "admin",
    event: {
      type: "market-data:job-started",
      data: { runId: row.id, jobType, startedAt: startedAt.toISOString() },
    },
  });

  return row.id;
}

function scalarResult(result: unknown) {
  if (!result || typeof result !== "object") return {};
  return Object.fromEntries(
    Object.entries(result as Record<string, unknown>).filter(
      ([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value),
    ),
  );
}

// Scheduled (repeatable) jobs are not started from the admin, so they have no sync_jobs row and never
// showed in the job table. This records one background_job_runs row around them. A job started from the
// admin already has its sync_jobs row, so it is not recorded a second time.
export async function recordScheduledJobRun<T>(
  input: { jobType: BackgroundJobType; exchange?: string; bullmqJobId?: string; hasSyncJob: boolean },
  run: () => Promise<T>,
): Promise<T> {
  if (input.hasSyncJob) return run();

  const startedAt = new Date();
  const [row] = await db
    .insert(backgroundJobRuns)
    .values({
      jobType: input.jobType,
      exchange: input.exchange ?? null,
      status: BACKGROUND_JOB_RUN_STATUS.running,
      scheduledAt: startedAt,
      startedAt,
      bullmqJobId: input.bullmqJobId ?? null,
    })
    .returning({ id: backgroundJobRuns.id });
  void publishRealtimeEvent({
    kind: "admin",
    event: { type: "market-data:job-started", data: { runId: row.id, jobType: input.jobType, startedAt: startedAt.toISOString() } },
  });

  try {
    const result = await run();
    const finishedAt = new Date();
    await db
      .update(backgroundJobRuns)
      .set({
        status: BACKGROUND_JOB_RUN_STATUS.completed,
        finishedAt,
        metadata: { result: scalarResult(result) },
        updatedAt: finishedAt,
      })
      .where(eq(backgroundJobRuns.id, row.id));
    void publishRealtimeEvent({
      kind: "admin",
      event: {
        type: "market-data:job-completed",
        data: {
          runId: row.id,
          jobType: input.jobType,
          status: "completed",
          finishedAt: finishedAt.toISOString(),
          processed: 0,
          updated: 0,
          repaired: 0,
          failed: 0,
        },
      },
    });
    return result;
  } catch (error) {
    await failBackgroundJobRun(row.id, input.jobType, getErrorMessage(error, "Job failed"));
    throw error;
  }
}

export async function emitJobProgress(input: {
  runId: string;
  jobType: BackgroundJobType;
  processed: number;
  total: number;
  updated: number;
  repaired: number;
  failed: number;
}) {
  void publishRealtimeEvent({
    kind: "admin",
    event: { type: "market-data:job-progress", data: input },
  });
}

export async function finishBackgroundJobRunFromSummary(id: string, jobType: BackgroundJobType, summary: DailyCandleSyncSummary) {
  const status = summary.failed === 0 ? BACKGROUND_JOB_RUN_STATUS.completed : BACKGROUND_JOB_RUN_STATUS.partial;
  const finishedAt = new Date();
  await db
    .update(backgroundJobRuns)
    .set({
      status,
      finishedAt,
      processedCount: summary.processed,
      updatedCount: summary.updated,
      repairedCount: summary.repaired,
      alreadyCurrentCount: summary.alreadyCurrent,
      bootstrapRequiredCount: summary.bootstrapRequired,
      failedCount: summary.failed,
      errorSummary: summary.failed > 0 ? `${summary.failed} symbol(s) failed to sync` : null,
      metadata: {
        failedSymbols: summary.failedDetails.slice(0, FAILED_SYMBOLS_METADATA_CAP),
        coverageExemptSymbols: summary.providerEmptySymbols,
      },
      updatedAt: finishedAt,
    })
    .where(eq(backgroundJobRuns.id, id));

  void publishRealtimeEvent({
    kind: "admin",
    event: {
      type: "market-data:job-completed",
      data: {
        runId: id,
        jobType,
        status,
        finishedAt: finishedAt.toISOString(),
        processed: summary.processed,
        updated: summary.updated,
        repaired: summary.repaired,
        failed: summary.failed,
      },
    },
  });
}

export async function failBackgroundJobRun(id: string, jobType: BackgroundJobType, errorMessage: string) {
  const finishedAt = new Date();
  await db
    .update(backgroundJobRuns)
    .set({ status: BACKGROUND_JOB_RUN_STATUS.failed, finishedAt, errorSummary: errorMessage, updatedAt: finishedAt })
    .where(eq(backgroundJobRuns.id, id));

  void publishRealtimeEvent({
    kind: "admin",
    event: {
      type: "market-data:job-failed",
      data: { runId: id, jobType, status: "failed", finishedAt: finishedAt.toISOString(), failed: 0 },
    },
  });
}

export async function recordChartEnsureFreshResultIfNeeded(
  result: { status: string; instrumentId: string | null; failedDates: string[] },
  symbol: string,
  exchange: string
) {
  if (result.status !== "updated" && result.status !== "repaired" && result.status !== "failed") return;
  await recordChartEnsureFreshRun({
    status: result.status,
    symbol,
    exchange,
    instrumentId: result.instrumentId,
    failedDates: result.failedDates,
  }).catch((error: unknown) => {
    logger.warn(
      { symbol, exchange, message: getErrorMessage(error, "Unknown error") },
      "Failed to record chart ensure-fresh run"
    );
  });

  if (result.status === "updated" || result.status === "repaired") {
    void publishRealtimeEvent({
      kind: "symbol",
      event: {
        exchange,
        symbol,
        instrumentId: result.instrumentId,
        latestDataDate: getLatestExpectedTradingDay(exchange),
        status: result.status,
        time: new Date().toISOString(),
      },
    });
  }
}

export async function recordChartEnsureFreshRun(input: {
  status: "updated" | "repaired" | "failed";
  symbol: string;
  exchange: string;
  instrumentId: string | null;
  failedDates?: string[];
}) {
  const isFailed = input.status === "failed";
  await db.insert(backgroundJobRuns).values({
    jobType: BACKGROUND_JOB_TYPES.chartEnsureFresh,
    status: isFailed ? BACKGROUND_JOB_RUN_STATUS.failed : BACKGROUND_JOB_RUN_STATUS.completed,
    startedAt: new Date(),
    finishedAt: new Date(),
    processedCount: 1,
    updatedCount: input.status === "updated" ? 1 : 0,
    repairedCount: input.status === "repaired" ? 1 : 0,
    failedCount: isFailed ? 1 : 0,
    errorSummary: isFailed ? "chart ensure-fresh repair failed" : null,
    metadata: {
      failedSymbols: isFailed
        ? ([
            {
              instrumentId: input.instrumentId,
              symbol: input.symbol,
              reason: (input.failedDates ?? []).length > 0 ? `persistence gap: ${input.failedDates!.join(",")}` : "sync failed",
            },
          ] satisfies DailyCandleSyncFailureDetail[])
        : [],
      exchange: input.exchange,
      symbol: input.symbol,
    },
  });
}

export async function listRecentBackgroundJobRuns(limit = RECENT_JOB_RUNS_DEFAULT_LIMIT) {
  return db.select().from(backgroundJobRuns).orderBy(desc(backgroundJobRuns.startedAt)).limit(limit);
}

export async function getLatestBackgroundJobRunByType(jobTypes: BackgroundJobType[]) {
  if (jobTypes.length === 0) return new Map<string, typeof backgroundJobRuns.$inferSelect>();

  const rows = await db
    .select()
    .from(backgroundJobRuns)
    .where(inArray(backgroundJobRuns.jobType, jobTypes))
    .orderBy(desc(backgroundJobRuns.startedAt));

  const latestByType = new Map<string, typeof backgroundJobRuns.$inferSelect>();
  for (const row of rows) {
    if (!latestByType.has(row.jobType)) latestByType.set(row.jobType, row);
  }
  return latestByType;
}

export async function getLastSuccessfulScheduledRefresh() {
  const [row] = await db
    .select({ finishedAt: backgroundJobRuns.finishedAt })
    .from(backgroundJobRuns)
    .where(
      and(
        inArray(backgroundJobRuns.jobType, SCHEDULED_DAILY_CANDLE_SYNC_JOB_TYPES),
        inArray(backgroundJobRuns.status, [BACKGROUND_JOB_RUN_STATUS.completed, BACKGROUND_JOB_RUN_STATUS.partial])
      )
    )
    .orderBy(desc(backgroundJobRuns.finishedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}
