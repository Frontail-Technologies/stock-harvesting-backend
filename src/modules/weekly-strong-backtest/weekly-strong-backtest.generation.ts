import { and, asc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { marketCollections, weeklyStrongBacktestRuns } from "../../db/schema";
import { badRequest } from "../../shared/errors";
import {
  getCollectionMembershipAt,
  resolveMembershipVersionsForDates,
} from "../market-collections/market-collection-versions.service";
import {
  getActiveMemberInstrumentRows,
  requireCollectionById,
} from "../market-collections/market-collections.service";
import {
  computeWeeklyStrongBacktestMembers,
  WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
} from "../market-data/market-data.service";
import {
  backtestDurationSeconds,
  backtestRunsTotal,
  backtestWeeksTotal,
  safeInc,
} from "../../shared/metrics/metrics";
import { CURRENT_MEMBERSHIP, HISTORICAL_MEMBERSHIP } from "./weekly-strong-backtest.constants";
import { persistWeeklyStrongBacktestWeek } from "./weekly-strong-backtest.persistence";

export type WeeklyStrongBacktestBackfillResult = {
  collectionId: string;
  weeksRequested: number;
  weeksGenerated: number;
  totalMembersPersisted: number;
};

// Entry-point instrumentation only - wraps the unmodified impl below, never touches evaluator internals.
export async function runWeeklyStrongBacktestBackfill(
  input: { collectionId: string; weeks?: number }
): Promise<WeeklyStrongBacktestBackfillResult> {
  const startedAt = Date.now();
  try {
    const result = await runWeeklyStrongBacktestBackfillImpl(input);
    recordBacktestRun("current_backfill", "success", startedAt, result.weeksGenerated);
    return result;
  } catch (error) {
    recordBacktestRun("current_backfill", "failed", startedAt);
    throw error;
  }
}

async function runWeeklyStrongBacktestBackfillImpl(input: {
  collectionId: string;
  weeks?: number;
}): Promise<WeeklyStrongBacktestBackfillResult> {
  const collection = await requireCollectionById(input.collectionId);
  const weeks = input.weeks ?? WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS;

  const memberRows = await getActiveMemberInstrumentRows(collection.id);
  const weekPoints = await computeWeeklyStrongBacktestMembers(memberRows, collection.exchange, weeks);
  const instrumentIdBySymbol = new Map(memberRows.map((row) => [row.symbol, row.instrumentId]));

  let weeksGenerated = 0;
  let totalMembersPersisted = 0;

  for (const point of weekPoints) {
    await persistWeeklyStrongBacktestWeek(collection.id, point, instrumentIdBySymbol, {
      mode: CURRENT_MEMBERSHIP,
      versionId: null,
    });
    weeksGenerated++;
    totalMembersPersisted += point.passing.length;
  }

  return {
    collectionId: collection.id,
    weeksRequested: weeks,
    weeksGenerated,
    totalMembersPersisted,
  };
}

export type WeeklyStrongBacktestHistoricalRebuildResult = {
  collectionId: string;
  weeksConsidered: number;
  weeksGenerated: number;
  totalMembersPersisted: number;
  uncoveredWeeks: string[];
  versionsUsed: number;
};

export async function runWeeklyStrongBacktestHistoricalRebuild(
  input: { collectionId: string }
): Promise<WeeklyStrongBacktestHistoricalRebuildResult> {
  const startedAt = Date.now();
  try {
    const result = await runWeeklyStrongBacktestHistoricalRebuildImpl(input);
    recordBacktestRun("historical_rebuild", "success", startedAt, result.weeksGenerated);
    return result;
  } catch (error) {
    recordBacktestRun("historical_rebuild", "failed", startedAt);
    throw error;
  }
}

async function runWeeklyStrongBacktestHistoricalRebuildImpl(input: {
  collectionId: string;
}): Promise<WeeklyStrongBacktestHistoricalRebuildResult> {
  const collection = await requireCollectionById(input.collectionId);

  const referenceWeeks = await db
    .selectDistinct({ weekEnding: weeklyStrongBacktestRuns.weekEnding })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collection.id),
        eq(weeklyStrongBacktestRuns.membershipMode, CURRENT_MEMBERSHIP),
      ),
    )
    .orderBy(asc(weeklyStrongBacktestRuns.weekEnding));

  if (referenceWeeks.length === 0) {
    throw badRequest(
      "Run the current-membership backtest at least once before rebuilding the historical-membership backtest.",
    );
  }

  const weekDates = referenceWeeks.map((row) => row.weekEnding);
  const versionByDate = await resolveMembershipVersionsForDates(collection.id, weekDates);

  const weeksByVersionId = new Map<string, { effectiveFrom: string; weeks: Set<string> }>();
  const uncoveredWeeks: string[] = [];
  for (const date of weekDates) {
    const resolved = versionByDate.get(date);
    if (!resolved) {
      uncoveredWeeks.push(date);
      continue;
    }
    const group = weeksByVersionId.get(resolved.versionId) ?? {
      effectiveFrom: resolved.effectiveFrom,
      weeks: new Set<string>(),
    };
    group.weeks.add(date);
    weeksByVersionId.set(resolved.versionId, group);
  }

  let weeksGenerated = 0;
  let totalMembersPersisted = 0;

  for (const [versionId, group] of weeksByVersionId) {
    const membership = await getCollectionMembershipAt(collection.id, group.effectiveFrom);
    if (!membership || membership.members.length === 0) continue;

    const memberRows = membership.members.map((member) => ({
      symbol: member.symbol,
      name: member.name,
      exchange: member.exchange,
      sector: member.sector,
      industry: member.industry,
    }));
    const instrumentIdBySymbol = new Map(
      membership.members.map((member) => [member.symbol, member.instrumentId]),
    );

    const weekPoints = await computeWeeklyStrongBacktestMembers(
      memberRows,
      collection.exchange,
      WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
    );
    const producedTimes = new Set(weekPoints.map((point) => point.time));
    for (const weekEnding of group.weeks) {
      if (!producedTimes.has(weekEnding)) uncoveredWeeks.push(weekEnding);
    }

    for (const point of weekPoints) {
      if (!group.weeks.has(point.time)) continue;
      await persistWeeklyStrongBacktestWeek(collection.id, point, instrumentIdBySymbol, {
        mode: HISTORICAL_MEMBERSHIP,
        versionId,
      });
      weeksGenerated++;
      totalMembersPersisted += point.passing.length;
    }
  }

  return {
    collectionId: collection.id,
    weeksConsidered: weekDates.length,
    weeksGenerated,
    totalMembersPersisted,
    uncoveredWeeks: [...new Set(uncoveredWeeks)].sort(),
    versionsUsed: weeksByVersionId.size,
  };
}

export type WeeklyStrongBacktestIncrementalResult = {
  collectionsChecked: number;
  weeksAdded: number;
};

export async function syncWeeklyStrongBacktestIncremental(
  exchange: string
): Promise<WeeklyStrongBacktestIncrementalResult> {
  const startedAt = Date.now();
  try {
    const result = await syncWeeklyStrongBacktestIncrementalImpl(exchange);
    recordBacktestRun("incremental", "success", startedAt, result.weeksAdded);
    return result;
  } catch (error) {
    recordBacktestRun("incremental", "failed", startedAt);
    throw error;
  }
}

function recordBacktestRun(
  type: "current_backfill" | "historical_rebuild" | "incremental",
  outcome: "success" | "failed",
  startedAt: number,
  weeksGenerated?: number
) {
  safeInc(backtestRunsTotal, { type, outcome });
  try {
    backtestDurationSeconds.observe({ type, outcome }, (Date.now() - startedAt) / 1000);
  } catch {
    // Metrics must never break the operation they observe.
  }
  if (weeksGenerated !== undefined) {
    safeInc(backtestWeeksTotal, { type }, weeksGenerated);
  }
}

async function syncWeeklyStrongBacktestIncrementalImpl(
  exchange: string,
): Promise<WeeklyStrongBacktestIncrementalResult> {
  const backfilledCollections = await db
    .selectDistinct({
      id: marketCollections.id,
      exchange: marketCollections.exchange,
      active: marketCollections.active,
    })
    .from(weeklyStrongBacktestRuns)
    .innerJoin(marketCollections, eq(weeklyStrongBacktestRuns.collectionId, marketCollections.id))
    .where(and(eq(marketCollections.exchange, exchange), eq(marketCollections.active, true)));

  let weeksAdded = 0;

  for (const collection of backfilledCollections) {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    if (memberRows.length === 0) continue;

    const [latestPoint] = await computeWeeklyStrongBacktestMembers(memberRows, collection.exchange, 1);
    if (!latestPoint) continue;

    const [existingRun] = await db
      .select({ id: weeklyStrongBacktestRuns.id })
      .from(weeklyStrongBacktestRuns)
      .where(
        and(
          eq(weeklyStrongBacktestRuns.collectionId, collection.id),
          eq(weeklyStrongBacktestRuns.weekEnding, latestPoint.time),
          eq(weeklyStrongBacktestRuns.membershipMode, CURRENT_MEMBERSHIP),
        ),
      )
      .limit(1);

    if (!existingRun) {
      const instrumentIdBySymbol = new Map(memberRows.map((row) => [row.symbol, row.instrumentId]));
      await persistWeeklyStrongBacktestWeek(collection.id, latestPoint, instrumentIdBySymbol, {
        mode: CURRENT_MEMBERSHIP,
        versionId: null,
      });
      weeksAdded++;
    }

    const membership = await getCollectionMembershipAt(collection.id, latestPoint.time);
    if (!membership || membership.members.length === 0) continue;

    const [existingHistoricalRun] = await db
      .select({ id: weeklyStrongBacktestRuns.id })
      .from(weeklyStrongBacktestRuns)
      .where(
        and(
          eq(weeklyStrongBacktestRuns.collectionId, collection.id),
          eq(weeklyStrongBacktestRuns.weekEnding, latestPoint.time),
          eq(weeklyStrongBacktestRuns.membershipMode, HISTORICAL_MEMBERSHIP),
        ),
      )
      .limit(1);
    if (existingHistoricalRun) continue;

    const versionMemberRows = membership.members.map((member) => ({
      symbol: member.symbol,
      name: member.name,
      exchange: member.exchange,
      sector: member.sector,
      industry: member.industry,
    }));
    const [versionLatestPoint] = await computeWeeklyStrongBacktestMembers(
      versionMemberRows,
      collection.exchange,
      1,
    );
    if (!versionLatestPoint || versionLatestPoint.time !== latestPoint.time) continue;

    const versionInstrumentIdBySymbol = new Map(
      membership.members.map((member) => [member.symbol, member.instrumentId]),
    );
    await persistWeeklyStrongBacktestWeek(collection.id, versionLatestPoint, versionInstrumentIdBySymbol, {
      mode: HISTORICAL_MEMBERSHIP,
      versionId: membership.versionId,
    });
  }

  return { collectionsChecked: backfilledCollections.length, weeksAdded };
}
