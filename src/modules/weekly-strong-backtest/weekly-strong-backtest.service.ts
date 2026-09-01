import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import {
  marketCollections,
  syncJobs,
  weeklyStrongBacktestMembers,
  weeklyStrongBacktestRuns,
} from "../../db/schema";
import { badRequest, notFound } from "../../shared/errors";
import { SYNC_JOB_TYPES } from "../../shared/constants";
import {
  getCollectionMembershipAt,
  resolveMembershipVersionsForDates,
} from "../market-collections/market-collection-versions.service";
import {
  getActiveMemberInstrumentRows,
  requireCollectionByCode,
  requireCollectionById,
} from "../market-collections/market-collections.service";
import {
  computeWeeklyStrongBacktestMembers,
  WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
  type WeeklyStrongBacktestWeekMembers,
} from "../market-data/market-data.service";
import { WEEKLY_STRONG_EVALUATOR_VERSION } from "../market-data/weekly-strong-evaluator";

const CURRENT_MEMBERSHIP = "current_membership" as const;
const HISTORICAL_MEMBERSHIP = "historical_membership" as const;
type WeeklyStrongBacktestMembershipMode =
  | typeof CURRENT_MEMBERSHIP
  | typeof HISTORICAL_MEMBERSHIP;
const UNCLASSIFIED_SECTOR_LABEL = "Unclassified";
const DASHBOARD_BACKTEST_WEEKS = 250;

function formatCoverageMonth(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

// runsChronological must already be sorted oldest-first.
function getMembershipNote(
  mode: WeeklyStrongBacktestMembershipMode,
  runsChronological: { weekEnding: string }[],
) {
  if (mode === CURRENT_MEMBERSHIP) {
    return "Backtest uses the segment's present-day constituent universe for every week shown. Import dated membership versions in Admin to unlock historically accurate point-in-time backtesting.";
  }
  if (runsChronological.length === 0) {
    return "Historical membership backtest has not been generated yet.";
  }
  const earliest = formatCoverageMonth(runsChronological[0].weekEnding);
  const latest = formatCoverageMonth(
    runsChronological[runsChronological.length - 1].weekEnding,
  );
  return `Historical membership coverage: ${earliest} → ${latest}. Each week uses that week's actual point-in-time segment constituents.`;
}

// ---------------------------------------------------------------------
// Backfill / rebuild (admin-triggered, see weekly-strong-backtest.routes.ts
// and admin.routes.ts's /market-collections/:id/weekly-strong-backtest/*)
// ---------------------------------------------------------------------

export type WeeklyStrongBacktestBackfillResult = {
  collectionId: string;
  weeksRequested: number;
  weeksGenerated: number;
  totalMembersPersisted: number;
};

// One pass over each active member's full history (see
// computeWeeklyStrongBacktestMembers - fetched once per instrument, not
// once per week), then one transaction per week to persist. Idempotent:
// rerunning upserts the run row and replaces its members, never
// duplicates (see the unique constraint on collectionId+weekEnding+
// membershipMode, and persistWeeklyStrongBacktestWeek's delete-then-insert
// of members).
export async function runWeeklyStrongBacktestBackfill(input: {
  collectionId: string;
  weeks?: number;
}): Promise<WeeklyStrongBacktestBackfillResult> {
  const collection = await requireCollectionById(input.collectionId);
  const weeks = input.weeks ?? WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS;

  const memberRows = await getActiveMemberInstrumentRows(collection.id);
  const weekPoints = await computeWeeklyStrongBacktestMembers(
    memberRows,
    collection.exchange,
    weeks,
  );
  const instrumentIdBySymbol = new Map(
    memberRows.map((row) => [row.symbol, row.instrumentId]),
  );

  let weeksGenerated = 0;
  let totalMembersPersisted = 0;

  for (const point of weekPoints) {
    await persistWeeklyStrongBacktestWeek(
      collection.id,
      point,
      instrumentIdBySymbol,
      {
        mode: CURRENT_MEMBERSHIP,
        versionId: null,
      },
    );
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

// ---------------------------------------------------------------------
// Historical-membership rebuild (admin-triggered). Reuses this
// collection's own already-persisted current_membership week list as the
// reference week set (never inventing a second date-derivation path) -
// a current_membership backfill must have run at least once first. For
// each reference week, resolves the version actually effective then via
// getCollectionMembershipAt, groups weeks by resolved version so each
// distinct version's member pool is fetched/evaluated exactly once (same
// "don't refetch per week" principle as the backfill above), and persists
// historical_membership runs stamped with that exact membershipVersionId.
// Weeks with no resolvable version (predate the earliest available
// version) are reported in uncoveredWeeks and never fabricated from
// today's active members.
// ---------------------------------------------------------------------

export type WeeklyStrongBacktestHistoricalRebuildResult = {
  collectionId: string;
  weeksConsidered: number;
  weeksGenerated: number;
  totalMembersPersisted: number;
  uncoveredWeeks: string[];
  versionsUsed: number;
};

export async function runWeeklyStrongBacktestHistoricalRebuild(input: {
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
  const versionByDate = await resolveMembershipVersionsForDates(
    collection.id,
    weekDates,
  );

  const weeksByVersionId = new Map<
    string,
    { effectiveFrom: string; weeks: Set<string> }
  >();
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
    const membership = await getCollectionMembershipAt(
      collection.id,
      group.effectiveFrom,
    );
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
      if (!group.weeks.has(point.time)) continue; // only this version's authoritative weeks
      await persistWeeklyStrongBacktestWeek(
        collection.id,
        point,
        instrumentIdBySymbol,
        {
          mode: HISTORICAL_MEMBERSHIP,
          versionId,
        },
      );
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

// ---------------------------------------------------------------------
// Weekly incremental (hooked into the existing 30-min instrument-sync job
// - see worker.ts. Only touches collections that already have at least
// one persisted current_membership run; never recomputes the full range.
// Always keeps producing current_membership runs (cheap, always
// available, used as the audit/fallback series). If the collection ALSO
// has at least one membership version, additionally resolves the version
// effective for that same newly-completed week and persists a
// historical_membership run for it - never using today's active
// membership blindly for that second run.
// ---------------------------------------------------------------------

export type WeeklyStrongBacktestIncrementalResult = {
  collectionsChecked: number;
  weeksAdded: number;
};

export async function syncWeeklyStrongBacktestIncremental(
  exchange: string,
): Promise<WeeklyStrongBacktestIncrementalResult> {
  const backfilledCollections = await db
    .selectDistinct({
      id: marketCollections.id,
      exchange: marketCollections.exchange,
      active: marketCollections.active,
    })
    .from(weeklyStrongBacktestRuns)
    .innerJoin(
      marketCollections,
      eq(weeklyStrongBacktestRuns.collectionId, marketCollections.id),
    )
    .where(
      and(
        eq(marketCollections.exchange, exchange),
        eq(marketCollections.active, true),
      ),
    );

  let weeksAdded = 0;

  for (const collection of backfilledCollections) {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    if (memberRows.length === 0) continue;

    // weeks=1: still fetches each member's full history once (the
    // evaluator needs the trailing lookback regardless), but only
    // evaluates/returns the single newest completed week.
    const [latestPoint] = await computeWeeklyStrongBacktestMembers(
      memberRows,
      collection.exchange,
      1,
    );
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
      const instrumentIdBySymbol = new Map(
        memberRows.map((row) => [row.symbol, row.instrumentId]),
      );
      await persistWeeklyStrongBacktestWeek(
        collection.id,
        latestPoint,
        instrumentIdBySymbol,
        {
          mode: CURRENT_MEMBERSHIP,
          versionId: null,
        },
      );
      weeksAdded++;
    }

    const membership = await getCollectionMembershipAt(
      collection.id,
      latestPoint.time,
    );
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
    if (!versionLatestPoint || versionLatestPoint.time !== latestPoint.time)
      continue;

    const versionInstrumentIdBySymbol = new Map(
      membership.members.map((member) => [member.symbol, member.instrumentId]),
    );
    await persistWeeklyStrongBacktestWeek(
      collection.id,
      versionLatestPoint,
      versionInstrumentIdBySymbol,
      {
        mode: HISTORICAL_MEMBERSHIP,
        versionId: membership.versionId,
      },
    );
  }

  return { collectionsChecked: backfilledCollections.length, weeksAdded };
}

// ---------------------------------------------------------------------
// Shared persist step (backfill, incremental, and historical rebuild all
// call this per week)
// ---------------------------------------------------------------------

// dbClient defaults to the real db - every real caller gets identical
// behavior to before this parameter existed. It exists so this function's
// idempotent-upsert transaction is directly testable with a fake client
// (see weekly-strong-backtest.persistence.test.ts), the same tiny-seam
// pattern replaceCandlesAtomically uses in market-data.service.ts.
export async function persistWeeklyStrongBacktestWeek(
  collectionId: string,
  point: WeeklyStrongBacktestWeekMembers,
  instrumentIdBySymbol: Map<string, string>,
  membership: {
    mode: WeeklyStrongBacktestMembershipMode;
    versionId: string | null;
  },
  dbClient: DbOrTx = db,
) {
  await dbClient.transaction(async (tx) => {
    const [run] = await tx
      .insert(weeklyStrongBacktestRuns)
      .values({
        collectionId,
        weekEnding: point.time,
        membershipMode: membership.mode,
        membershipVersionId: membership.versionId,
        evaluatorVersion: WEEKLY_STRONG_EVALUATOR_VERSION,
        totalPassing: point.passing.length,
      })
      .onConflictDoUpdate({
        target: [
          weeklyStrongBacktestRuns.collectionId,
          weeklyStrongBacktestRuns.weekEnding,
          weeklyStrongBacktestRuns.membershipMode,
        ],
        set: {
          membershipVersionId: membership.versionId,
          evaluatorVersion: WEEKLY_STRONG_EVALUATOR_VERSION,
          totalPassing: point.passing.length,
          generatedAt: new Date(),
        },
      })
      .returning();

    // Idempotent rerun: clear this run's previous members before
    // re-inserting, rather than trying to diff them - each run's member
    // set is bounded by the collection's own size, so this is cheap, and
    // it guarantees no stale row from a prior generation can survive a
    // rebuild.
    await tx
      .delete(weeklyStrongBacktestMembers)
      .where(eq(weeklyStrongBacktestMembers.runId, run.id));

    const memberValues = point.passing
      .map((member) => {
        const instrumentId = instrumentIdBySymbol.get(member.symbol);
        if (!instrumentId) return null; // shouldn't happen - member always came from this same pool
        return {
          runId: run.id,
          instrumentId,
          symbol: member.symbol,
          name: member.name,
          exchange: member.exchange,
          sector: member.sector,
          industry: member.industry,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (memberValues.length > 0) {
      await tx.insert(weeklyStrongBacktestMembers).values(memberValues);
    }
  });
}

// ---------------------------------------------------------------------
// Dashboard reads - persisted data only, never runs the evaluator.
// ---------------------------------------------------------------------

export type WeeklyStrongBacktestSectorCount = { sector: string; count: number };
export type WeeklyStrongBacktestStackedPoint = {
  weekEnding: string;
  total: number;
  sectors: WeeklyStrongBacktestSectorCount[];
};

// Shared by both Dashboard reads below: prefer historical_membership runs
// when the collection has any, falling back to current_membership only
// when it has none - the two modes are never mixed within one response.
async function selectPreferredRuns(collectionId: string) {
  const historicalRuns = await db
    .select({
      id: weeklyStrongBacktestRuns.id,
      weekEnding: weeklyStrongBacktestRuns.weekEnding,
      totalPassing: weeklyStrongBacktestRuns.totalPassing,
    })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, HISTORICAL_MEMBERSHIP),
      ),
    )
    .orderBy(desc(weeklyStrongBacktestRuns.weekEnding))
    .limit(DASHBOARD_BACKTEST_WEEKS);

  if (historicalRuns.length > 0) {
    return {
      mode: HISTORICAL_MEMBERSHIP as WeeklyStrongBacktestMembershipMode,
      runs: historicalRuns,
    };
  }

  const currentRuns = await db
    .select({
      id: weeklyStrongBacktestRuns.id,
      weekEnding: weeklyStrongBacktestRuns.weekEnding,
      totalPassing: weeklyStrongBacktestRuns.totalPassing,
    })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, CURRENT_MEMBERSHIP),
      ),
    )
    .orderBy(desc(weeklyStrongBacktestRuns.weekEnding))
    .limit(DASHBOARD_BACKTEST_WEEKS);

  return {
    mode: CURRENT_MEMBERSHIP as WeeklyStrongBacktestMembershipMode,
    runs: currentRuns,
  };
}

export async function getWeeklyStrongBacktestStacked(input: { code: string }) {
  const collection = await requireCollectionByCode(input.code);
  const { mode, runs } = await selectPreferredRuns(collection.id);

  const baseResponse = {
    collection: { code: collection.code, name: collection.name },
    membershipMode: mode,
  };

  if (runs.length === 0) {
    return {
      ...baseResponse,
      membershipNote: getMembershipNote(mode, []),
      generated: false,
      points: [] as WeeklyStrongBacktestStackedPoint[],
    };
  }

  const runIds = runs.map((run) => run.id);
  const sectorRows = await db
    .select({
      runId: weeklyStrongBacktestMembers.runId,
      sector: weeklyStrongBacktestMembers.sector,
      count: sql<number>`count(*)::int`,
    })
    .from(weeklyStrongBacktestMembers)
    .where(inArray(weeklyStrongBacktestMembers.runId, runIds))
    .groupBy(
      weeklyStrongBacktestMembers.runId,
      weeklyStrongBacktestMembers.sector,
    );

  const sectorsByRunId = new Map<string, WeeklyStrongBacktestSectorCount[]>();
  for (const row of sectorRows) {
    const list = sectorsByRunId.get(row.runId) ?? [];
    // Missing sector metadata still counts toward the week's total - it's
    // grouped honestly as "Unclassified" rather than silently dropped, so
    // sum(sectors[].count) always equals total.
    list.push({
      sector: row.sector ?? UNCLASSIFIED_SECTOR_LABEL,
      count: row.count,
    });
    sectorsByRunId.set(row.runId, list);
  }

  const points: WeeklyStrongBacktestStackedPoint[] = runs
    .map((run) => ({
      weekEnding: run.weekEnding,
      total: run.totalPassing,
      sectors: (sectorsByRunId.get(run.id) ?? []).sort(
        (a, b) => b.count - a.count,
      ),
    }))
    // Runs were fetched newest-first (for the LIMIT to keep the latest
    // 250), reversed here to chronological order for the chart.
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));

  return {
    ...baseResponse,
    membershipNote: getMembershipNote(mode, points),
    generated: true,
    points,
  };
}

export type WeeklyStrongBacktestWeekDetailMember = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
};

export async function getWeeklyStrongBacktestWeekDetail(input: {
  code: string;
  weekEnding: string;
}) {
  const collection = await requireCollectionByCode(input.code);

  const runBaseSelect = {
    id: weeklyStrongBacktestRuns.id,
    weekEnding: weeklyStrongBacktestRuns.weekEnding,
    totalPassing: weeklyStrongBacktestRuns.totalPassing,
  };

  const [historicalRun] = await db
    .select(runBaseSelect)
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collection.id),
        eq(weeklyStrongBacktestRuns.weekEnding, input.weekEnding),
        eq(weeklyStrongBacktestRuns.membershipMode, HISTORICAL_MEMBERSHIP),
      ),
    )
    .limit(1);

  const mode: WeeklyStrongBacktestMembershipMode = historicalRun
    ? HISTORICAL_MEMBERSHIP
    : CURRENT_MEMBERSHIP;
  const run =
    historicalRun ??
    (
      await db
        .select(runBaseSelect)
        .from(weeklyStrongBacktestRuns)
        .where(
          and(
            eq(weeklyStrongBacktestRuns.collectionId, collection.id),
            eq(weeklyStrongBacktestRuns.weekEnding, input.weekEnding),
            eq(weeklyStrongBacktestRuns.membershipMode, CURRENT_MEMBERSHIP),
          ),
        )
        .limit(1)
    )[0];

  if (!run) throw notFound("No backtest run for that week");

  const members: WeeklyStrongBacktestWeekDetailMember[] = await db
    .select({
      symbol: weeklyStrongBacktestMembers.symbol,
      name: weeklyStrongBacktestMembers.name,
      exchange: weeklyStrongBacktestMembers.exchange,
      sector: weeklyStrongBacktestMembers.sector,
      industry: weeklyStrongBacktestMembers.industry,
    })
    .from(weeklyStrongBacktestMembers)
    .where(eq(weeklyStrongBacktestMembers.runId, run.id))
    .orderBy(asc(weeklyStrongBacktestMembers.symbol));

  return {
    collection: { code: collection.code, name: collection.name },
    weekEnding: run.weekEnding,
    total: run.totalPassing,
    membershipMode: mode,
    membershipNote: getMembershipNote(mode, [{ weekEnding: run.weekEnding }]),
    members,
  };
}

// ---------------------------------------------------------------------
// Admin status (Not generated / Generating / Ready / Failed)
// ---------------------------------------------------------------------

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

export async function getWeeklyStrongBacktestStatus(input: {
  collectionId: string;
}): Promise<WeeklyStrongBacktestStatus> {
  return getWeeklyStrongBacktestStatusForMode(
    input.collectionId,
    SYNC_JOB_TYPES.weeklyStrongBacktestBackfill,
    CURRENT_MEMBERSHIP,
  );
}

// Same shape, scoped to historical_membership runs and the historical
// rebuild job type - kept as a separate exported function (rather than an
// optional param on the one above) so existing current-membership status
// callers are untouched.
export async function getWeeklyStrongBacktestHistoricalStatus(input: {
  collectionId: string;
}): Promise<WeeklyStrongBacktestStatus> {
  return getWeeklyStrongBacktestStatusForMode(
    input.collectionId,
    SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild,
    HISTORICAL_MEMBERSHIP,
  );
}

async function getWeeklyStrongBacktestStatusForMode(
  collectionId: string,
  jobType: string,
  mode: WeeklyStrongBacktestMembershipMode,
): Promise<WeeklyStrongBacktestStatus> {
  const [latestJob] = await db
    .select({ status: syncJobs.status, errorMessage: syncJobs.errorMessage })
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.type, jobType),
        sql`${syncJobs.payload} ->> 'collectionId' = ${collectionId}`,
      ),
    )
    .orderBy(desc(syncJobs.createdAt))
    .limit(1);

  // A running/queued job takes priority over whatever's already persisted
  // - if one's in flight, that's the state to show.
  if (
    latestJob &&
    (latestJob.status === "queued" || latestJob.status === "running")
  ) {
    return { state: "generating" };
  }

  const [stats] = await db
    .select({
      weeksGenerated: sql<number>`count(*)::int`,
      latestWeek: sql<
        string | null
      >`max(${weeklyStrongBacktestRuns.weekEnding})`,
      lastGeneratedAt: sql<
        string | null
      >`max(${weeklyStrongBacktestRuns.generatedAt})`,
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
