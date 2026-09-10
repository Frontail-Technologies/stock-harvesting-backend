import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { instruments, weeklyStrongBacktestMembers, weeklyStrongBacktestRuns } from "../../db/schema";
import { notFound } from "../../shared/errors";
import { requireCollectionByCode } from "../market-collections/market-collections.service";
import { getIsoWeekRange, getWeekEndingFriday } from "../market-data/trading-calendar";
import {
  CURRENT_MEMBERSHIP,
  DASHBOARD_BACKTEST_WEEKS,
  HISTORICAL_MEMBERSHIP,
  UNCLASSIFIED_SECTOR_LABEL,
  type WeeklyStrongBacktestMembershipMode,
} from "./weekly-strong-backtest.constants";

function formatCoverageMonth(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

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
  const latest = formatCoverageMonth(runsChronological[runsChronological.length - 1].weekEnding);
  return `Historical membership coverage: ${earliest} → ${latest}. Each week uses that week's actual point-in-time segment constituents.`;
}

async function selectPreferredRuns(collectionId: string, limit: number = DASHBOARD_BACKTEST_WEEKS) {
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
    .limit(limit);

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
    .limit(limit);

  return {
    mode: CURRENT_MEMBERSHIP as WeeklyStrongBacktestMembershipMode,
    runs: currentRuns,
  };
}

export type WeeklyStrongBacktestSectorCount = { sector: string; count: number };
export type WeeklyStrongBacktestStackedPoint = {
  weekEnding: string;
  total: number;
  sectors: WeeklyStrongBacktestSectorCount[];
};

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
  // The frozen `sector` on the member row is authoritative when it was set
  // at generation time (a later reclassification must not rewrite a past
  // week - see the schema comment). But a run generated before sector
  // classification data existed has `sector = NULL` for every member, which
  // would collapse the whole chart into "Unclassified" forever. COALESCE to
  // the instrument's current classification fills only those genuine gaps -
  // a non-null frozen value is always kept as-is.
  const coalescedSector = sql<string | null>`coalesce(${weeklyStrongBacktestMembers.sector}, ${instruments.sector})`;
  const sectorRows = await db
    .select({
      runId: weeklyStrongBacktestMembers.runId,
      sector: coalescedSector,
      count: sql<number>`count(*)::int`,
    })
    .from(weeklyStrongBacktestMembers)
    .innerJoin(instruments, eq(instruments.id, weeklyStrongBacktestMembers.instrumentId))
    .where(inArray(weeklyStrongBacktestMembers.runId, runIds))
    .groupBy(weeklyStrongBacktestMembers.runId, coalescedSector);

  const sectorsByRunId = new Map<string, WeeklyStrongBacktestSectorCount[]>();
  for (const row of sectorRows) {
    const list = sectorsByRunId.get(row.runId) ?? [];
    list.push({
      sector: row.sector ?? UNCLASSIFIED_SECTOR_LABEL,
      count: row.count,
    });
    sectorsByRunId.set(row.runId, list);
  }

  const points: WeeklyStrongBacktestStackedPoint[] = runs
    .map((run) => ({
      weekEnding: getWeekEndingFriday(run.weekEnding),
      total: run.totalPassing,
      sectors: (sectorsByRunId.get(run.id) ?? []).sort((a, b) => b.count - a.count),
    }))
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

export async function getWeeklyStrongBacktestWeekDetail(input: { code: string; weekEnding: string }) {
  const collection = await requireCollectionByCode(input.code);
  const { start, end } = getIsoWeekRange(input.weekEnding);

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
        gte(weeklyStrongBacktestRuns.weekEnding, start),
        lte(weeklyStrongBacktestRuns.weekEnding, end),
        eq(weeklyStrongBacktestRuns.membershipMode, HISTORICAL_MEMBERSHIP),
      ),
    )
    .limit(1);

  const mode: WeeklyStrongBacktestMembershipMode = historicalRun ? HISTORICAL_MEMBERSHIP : CURRENT_MEMBERSHIP;
  const run =
    historicalRun ??
    (
      await db
        .select(runBaseSelect)
        .from(weeklyStrongBacktestRuns)
        .where(
          and(
            eq(weeklyStrongBacktestRuns.collectionId, collection.id),
            gte(weeklyStrongBacktestRuns.weekEnding, start),
            lte(weeklyStrongBacktestRuns.weekEnding, end),
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
      // Same fill-only-when-missing fallback as getWeeklyStrongBacktestStacked.
      sector: sql<string | null>`coalesce(${weeklyStrongBacktestMembers.sector}, ${instruments.sector})`,
      industry: sql<string | null>`coalesce(${weeklyStrongBacktestMembers.industry}, ${instruments.industry})`,
    })
    .from(weeklyStrongBacktestMembers)
    .innerJoin(instruments, eq(instruments.id, weeklyStrongBacktestMembers.instrumentId))
    .where(eq(weeklyStrongBacktestMembers.runId, run.id))
    .orderBy(asc(weeklyStrongBacktestMembers.symbol));

  const weekEnding = getWeekEndingFriday(run.weekEnding);

  return {
    collection: { code: collection.code, name: collection.name },
    weekEnding,
    total: run.totalPassing,
    membershipMode: mode,
    membershipNote: getMembershipNote(mode, [{ weekEnding }]),
    members,
  };
}

export type WeeklyStrongBacktestMembershipChangeMember = {
  symbol: string;
  name: string;
  exchange: string;
};

export type WeeklyStrongBacktestMembershipChanges = {
  collection: { code: string; name: string };
  membershipMode: WeeklyStrongBacktestMembershipMode;
  available: boolean;
  weekEnding: string | null;
  previousWeekEnding: string | null;
  enteredStocks: WeeklyStrongBacktestMembershipChangeMember[];
  exitedStocks: WeeklyStrongBacktestMembershipChangeMember[];
};

function membershipKey(member: { exchange: string; symbol: string }) {
  return `${member.exchange}:${member.symbol}`;
}

async function resolveMembershipMode(collectionId: string): Promise<WeeklyStrongBacktestMembershipMode> {
  const [existingHistoricalRun] = await db
    .select({ id: weeklyStrongBacktestRuns.id })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, HISTORICAL_MEMBERSHIP),
      ),
    )
    .limit(1);

  return existingHistoricalRun ? HISTORICAL_MEMBERSHIP : CURRENT_MEMBERSHIP;
}

type BacktestRunRow = { id: string; weekEnding: string; totalPassing: number };

async function findRunForWeek(
  collectionId: string,
  mode: WeeklyStrongBacktestMembershipMode,
  weekEnding: string,
): Promise<BacktestRunRow | null> {
  const { start, end } = getIsoWeekRange(weekEnding);
  const [run] = await db
    .select({
      id: weeklyStrongBacktestRuns.id,
      weekEnding: weeklyStrongBacktestRuns.weekEnding,
      totalPassing: weeklyStrongBacktestRuns.totalPassing,
    })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, mode),
        gte(weeklyStrongBacktestRuns.weekEnding, start),
        lte(weeklyStrongBacktestRuns.weekEnding, end),
      ),
    )
    .limit(1);

  return run ?? null;
}

async function findPreviousRun(
  collectionId: string,
  mode: WeeklyStrongBacktestMembershipMode,
  beforeWeekEnding: string,
): Promise<BacktestRunRow | null> {
  const [run] = await db
    .select({
      id: weeklyStrongBacktestRuns.id,
      weekEnding: weeklyStrongBacktestRuns.weekEnding,
      totalPassing: weeklyStrongBacktestRuns.totalPassing,
    })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, mode),
        lt(weeklyStrongBacktestRuns.weekEnding, beforeWeekEnding),
      ),
    )
    .orderBy(desc(weeklyStrongBacktestRuns.weekEnding))
    .limit(1);

  return run ?? null;
}

export function computeMembershipChanges<T extends WeeklyStrongBacktestMembershipChangeMember>(
  currentMembers: T[],
  previousMembers: T[] | null,
): { enteredStocks: T[]; exitedStocks: T[] } {
  if (!previousMembers) {
    return { enteredStocks: currentMembers, exitedStocks: [] };
  }

  const previousKeys = new Set(previousMembers.map(membershipKey));
  const currentKeys = new Set(currentMembers.map(membershipKey));

  return {
    enteredStocks: currentMembers.filter((member) => !previousKeys.has(membershipKey(member))),
    exitedStocks: previousMembers.filter((member) => !currentKeys.has(membershipKey(member))),
  };
}

export async function getWeeklyStrongBacktestMembershipChanges(input: {
  code: string;
  weekEnding: string;
}): Promise<WeeklyStrongBacktestMembershipChanges> {
  const collection = await requireCollectionByCode(input.code);
  const mode = await resolveMembershipMode(collection.id);

  const baseResponse = {
    collection: { code: collection.code, name: collection.name },
    membershipMode: mode,
  };

  const currentRun = await findRunForWeek(collection.id, mode, input.weekEnding);

  if (!currentRun) {
    return {
      ...baseResponse,
      available: false,
      weekEnding: null,
      previousWeekEnding: null,
      enteredStocks: [],
      exitedStocks: [],
    };
  }

  const previousRun = await findPreviousRun(collection.id, mode, currentRun.weekEnding);

  const runIds = previousRun ? [currentRun.id, previousRun.id] : [currentRun.id];
  const memberRows = await db
    .select({
      runId: weeklyStrongBacktestMembers.runId,
      symbol: weeklyStrongBacktestMembers.symbol,
      name: weeklyStrongBacktestMembers.name,
      exchange: weeklyStrongBacktestMembers.exchange,
    })
    .from(weeklyStrongBacktestMembers)
    .where(inArray(weeklyStrongBacktestMembers.runId, runIds))
    .orderBy(asc(weeklyStrongBacktestMembers.symbol));

  const currentMembers = memberRows.filter((row) => row.runId === currentRun.id);
  const previousMembers = previousRun ? memberRows.filter((row) => row.runId === previousRun.id) : null;

  const toChangeMember = (row: (typeof memberRows)[number]): WeeklyStrongBacktestMembershipChangeMember => ({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
  });

  const { enteredStocks, exitedStocks } = computeMembershipChanges(
    currentMembers.map(toChangeMember),
    previousMembers?.map(toChangeMember) ?? null,
  );

  return {
    ...baseResponse,
    available: true,
    weekEnding: getWeekEndingFriday(currentRun.weekEnding),
    previousWeekEnding: previousRun ? getWeekEndingFriday(previousRun.weekEnding) : null,
    enteredStocks,
    exitedStocks,
  };
}
