import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  marketCollections,
  marketCollectionVersions,
  syncJobs,
  weeklyStrongBacktestRuns,
} from "../../db/schema";
import { JOB_NAMES, JOB_STATUS, SYNC_JOB_TYPES } from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { addJobWithTimeout, getMarketDataQueue } from "../jobs/queues";
import { CURRENT_MEMBERSHIP, HISTORICAL_MEMBERSHIP } from "./weekly-strong-backtest.constants";
import { syncWeeklyStrongBacktestIncremental } from "./weekly-strong-backtest.generation";

type AutomaticBacktestType =
  | typeof SYNC_JOB_TYPES.weeklyStrongBacktestBackfill
  | typeof SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild;

export function classifyBacktestReconciliation(input: {
  collectionIds: string[];
  currentIds: Set<string>;
  historicalIds: Set<string>;
  versionedIds: Set<string>;
}) {
  return {
    incrementalIds: input.collectionIds.filter((id) => input.currentIds.has(id)),
    initialIds: input.collectionIds.filter((id) => !input.currentIds.has(id)),
    historicalIds: input.collectionIds.filter(
      (id) => input.currentIds.has(id) && input.versionedIds.has(id) && !input.historicalIds.has(id),
    ),
  };
}

async function enqueueCollectionBacktest(input: {
  collectionId: string;
  exchange: string;
  type: AutomaticBacktestType;
}) {
  const queue = getMarketDataQueue();
  if (!queue) return "unavailable" as const;
  const historical = input.type === SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild;
  const jobId = `${historical ? "auto-weekly-strong-historical" : "auto-weekly-strong-current"}:${input.collectionId}`;
  const queuedJob = await queue.getJob(jobId);
  if (queuedJob) {
    const state = await queuedJob.getState();
    if (state === "waiting" || state === "active" || state === "delayed" || state === "waiting-children") {
      return "active" as const;
    }
  }

  const existing = await db
    .select({ id: syncJobs.id })
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.type, input.type),
        inArray(syncJobs.status, [JOB_STATUS.queued, JOB_STATUS.running]),
        sql`${syncJobs.payload} ->> 'collectionId' = ${input.collectionId}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) return "active" as const;

  const [syncJob] = await db
    .insert(syncJobs)
    .values({
      type: input.type,
      status: JOB_STATUS.queued,
      payload: { collectionId: input.collectionId, exchange: input.exchange, automatic: true, progress: 0 },
    })
    .returning({ id: syncJobs.id });

  try {
    await addJobWithTimeout(
      queue,
      historical ? JOB_NAMES.weeklyStrongBacktestHistoricalRebuild : JOB_NAMES.weeklyStrongBacktestBackfill,
      {
        syncJobId: syncJob.id,
        collectionId: input.collectionId,
        exchange: input.exchange,
        automatic: true,
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
    return "queued" as const;
  } catch (error) {
    await db
      .update(syncJobs)
      .set({
        status: JOB_STATUS.failed,
        errorMessage: getErrorMessage(error, "Automatic backtest enqueue failed"),
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, syncJob.id));
    return "failed" as const;
  }
}

export async function reconcileWeeklyStrongBacktests(exchange: string) {
  const [collections, currentRuns, historicalRuns, versionedCollections] = await Promise.all([
    db
      .select({ id: marketCollections.id })
      .from(marketCollections)
      .where(and(eq(marketCollections.exchange, exchange), eq(marketCollections.active, true))),
    db
      .selectDistinct({ collectionId: weeklyStrongBacktestRuns.collectionId })
      .from(weeklyStrongBacktestRuns)
      .where(eq(weeklyStrongBacktestRuns.membershipMode, CURRENT_MEMBERSHIP)),
    db
      .selectDistinct({ collectionId: weeklyStrongBacktestRuns.collectionId })
      .from(weeklyStrongBacktestRuns)
      .where(eq(weeklyStrongBacktestRuns.membershipMode, HISTORICAL_MEMBERSHIP)),
    db
      .selectDistinct({ collectionId: marketCollectionVersions.collectionId })
      .from(marketCollectionVersions),
  ]);

  const currentIds = new Set(currentRuns.map((row) => row.collectionId));
  const historicalIds = new Set(historicalRuns.map((row) => row.collectionId));
  const versionedIds = new Set(versionedCollections.map((row) => row.collectionId));
  const plan = classifyBacktestReconciliation({
    collectionIds: collections.map((collection) => collection.id),
    currentIds,
    historicalIds,
    versionedIds,
  });
  const results: Array<"queued" | "active" | "failed" | "unavailable"> = [];

  if (plan.incrementalIds.length > 0) await syncWeeklyStrongBacktestIncremental(exchange);

  for (const collectionId of plan.initialIds) {
      results.push(await enqueueCollectionBacktest({
        collectionId,
        exchange,
        type: SYNC_JOB_TYPES.weeklyStrongBacktestBackfill,
      }));
  }
  for (const collectionId of plan.historicalIds) {
      results.push(await enqueueCollectionBacktest({
        collectionId,
        exchange,
        type: SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild,
      }));
  }

  const result = {
    collectionsChecked: collections.length,
    initialized: plan.incrementalIds.length,
    queued: results.filter((value) => value === "queued").length,
    active: results.filter((value) => value === "active").length,
    failed: results.filter((value) => value === "failed").length,
    queueUnavailable: results.filter((value) => value === "unavailable").length,
  };
  logger.info({ exchange, ...result }, "Reconciled automatic Weekly Strong backtests");
  return result;
}
