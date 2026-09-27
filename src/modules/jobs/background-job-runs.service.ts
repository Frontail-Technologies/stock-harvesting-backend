import { and, desc, eq, inArray, sql } from "drizzle-orm";

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
import { getMarketDataQueue } from "./queues";

const FAILED_SYMBOLS_METADATA_CAP = 25;
const RECENT_JOB_RUNS_DEFAULT_LIMIT = 200;
const QUEUE_LOOKUP_TIMEOUT_MS = 3_000;
const ACTIVE_DATABASE_STATUSES = new Set<string>([
  BACKGROUND_JOB_RUN_STATUS.queued,
  BACKGROUND_JOB_RUN_STATUS.running,
]);
let queueReconciliationWarningLogged = false;

export type BackgroundJobQueueState =
  | "active"
  | "waiting"
  | "waiting-children"
  | "delayed"
  | "prioritized"
  | "completed"
  | "failed"
  | "missing"
  | "not-linked"
  | "unavailable";

async function withQueueLookupTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Redis job lookup timed out")), QUEUE_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function markOrphanedRun(id: string, reason: string) {
  const finishedAt = new Date();
  await db
    .update(backgroundJobRuns)
    .set({
      status: BACKGROUND_JOB_RUN_STATUS.failed,
      finishedAt,
      errorSummary: reason,
      updatedAt: finishedAt,
    })
    .where(eq(backgroundJobRuns.id, id));
  return finishedAt;
}

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
  await db
    .update(backgroundJobRuns)
    .set({
      processedCount: input.processed,
      updatedCount: input.updated,
      repairedCount: input.repaired,
      failedCount: input.failed,
      totalExpected: input.total,
      updatedAt: new Date(),
    })
    .where(eq(backgroundJobRuns.id, input.runId));
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
  const rows = await db
    .select()
    .from(backgroundJobRuns)
    .orderBy(
      desc(sql`coalesce(${backgroundJobRuns.startedAt}, ${backgroundJobRuns.scheduledAt}, ${backgroundJobRuns.createdAt})`)
    )
    .limit(limit);

  const activeRows = rows.filter((row) => ACTIVE_DATABASE_STATUSES.has(row.status));
  if (activeRows.length === 0) return rows.map((row) => ({ ...row, queueState: "not-linked" as const }));

  const queue = getMarketDataQueue();
  if (!queue) {
    return rows.map((row) => ({
      ...row,
      queueState: ACTIVE_DATABASE_STATUSES.has(row.status) ? "unavailable" as const : "not-linked" as const,
    }));
  }

  const queueStates = new Map<string, BackgroundJobQueueState>();
  let queueLookupError: unknown = null;
  await Promise.all(activeRows.map(async (row) => {
    if (!row.bullmqJobId) {
      queueStates.set(row.id, "missing");
      return;
    }
    try {
      const job = await withQueueLookupTimeout(queue.getJob(row.bullmqJobId));
      queueStates.set(row.id, job ? await withQueueLookupTimeout(job.getState()) as BackgroundJobQueueState : "missing");
    } catch (error) {
      queueStates.set(row.id, "unavailable");
      queueLookupError ??= error;
    }
  }));
  if (queueLookupError && !queueReconciliationWarningLogged) {
    queueReconciliationWarningLogged = true;
    logger.warn(
      { message: getErrorMessage(queueLookupError, "Queue lookup failed") },
      "Could not reconcile background job runs with Redis",
    );
  } else if (!queueLookupError) {
    queueReconciliationWarningLogged = false;
  }

  return Promise.all(rows.map(async (row) => {
    if (!ACTIVE_DATABASE_STATUSES.has(row.status)) return { ...row, queueState: "not-linked" as const };

    const queueState = queueStates.get(row.id) ?? "unavailable";
    const isOrphaned = queueState === "missing";
    const queueFinishedWithoutDb = queueState === "completed" || queueState === "failed";
    if (!isOrphaned && !queueFinishedWithoutDb) return { ...row, queueState };

    const reason = isOrphaned
      ? "Orphaned job: no corresponding Redis queue job exists"
      : `Queue job is ${queueState}, but its database run was never finalised`;
    const finishedAt = await markOrphanedRun(row.id, reason);
    return {
      ...row,
      status: BACKGROUND_JOB_RUN_STATUS.failed,
      finishedAt,
      errorSummary: reason,
      updatedAt: finishedAt,
      queueState,
    };
  }));
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
