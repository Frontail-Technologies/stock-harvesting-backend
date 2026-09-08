import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { syncJobs, weeklyStrongBacktestRuns } from "../../db/schema";
import { SYNC_JOB_TYPES } from "../../shared/constants";
import {
  CURRENT_MEMBERSHIP,
  HISTORICAL_MEMBERSHIP,
  type WeeklyStrongBacktestMembershipMode,
} from "./weekly-strong-backtest.constants";

export type WeeklyStrongBacktestStatus =
  | { state: "not_generated" }
  | { state: "generating" }
  | {
      state: "ready";
      weeksGenerated: number;
      latestWeek: string;
      lastGeneratedAt: string;
    }
  | { state: "failed"; errorMessage: string | null };

async function getWeeklyStrongBacktestStatusForMode(
  collectionId: string,
  jobType: string,
  mode: WeeklyStrongBacktestMembershipMode,
): Promise<WeeklyStrongBacktestStatus> {
  const [latestJob] = await db
    .select({ status: syncJobs.status, errorMessage: syncJobs.errorMessage })
    .from(syncJobs)
    .where(
      and(eq(syncJobs.type, jobType), sql`${syncJobs.payload} ->> 'collectionId' = ${collectionId}`),
    )
    .orderBy(desc(syncJobs.createdAt))
    .limit(1);

  if (latestJob && (latestJob.status === "queued" || latestJob.status === "running")) {
    return { state: "generating" };
  }

  const [stats] = await db
    .select({
      weeksGenerated: sql<number>`count(*)::int`,
      latestWeek: sql<string | null>`max(${weeklyStrongBacktestRuns.weekEnding})`,
      lastGeneratedAt: sql<string | null>`max(${weeklyStrongBacktestRuns.generatedAt})`,
    })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, mode),
      ),
    );

  if (stats && stats.weeksGenerated > 0 && stats.latestWeek) {
    return {
      state: "ready",
      weeksGenerated: stats.weeksGenerated,
      latestWeek: stats.latestWeek,
      lastGeneratedAt: stats.lastGeneratedAt ?? new Date().toISOString(),
    };
  }

  if (latestJob && latestJob.status === "failed") {
    return { state: "failed", errorMessage: latestJob.errorMessage };
  }

  return { state: "not_generated" };
}

export async function getWeeklyStrongBacktestStatus(input: {
  collectionId: string;
}): Promise<WeeklyStrongBacktestStatus> {
  return getWeeklyStrongBacktestStatusForMode(
    input.collectionId,
    SYNC_JOB_TYPES.weeklyStrongBacktestBackfill,
    CURRENT_MEMBERSHIP,
  );
}

export async function getWeeklyStrongBacktestHistoricalStatus(input: {
  collectionId: string;
}): Promise<WeeklyStrongBacktestStatus> {
  return getWeeklyStrongBacktestStatusForMode(
    input.collectionId,
    SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild,
    HISTORICAL_MEMBERSHIP,
  );
}
