import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { instruments, weeklyStrongBacktestMembers, weeklyStrongBacktestRuns } from "../../db/schema";
import { CANDLE_TIMEFRAME } from "../../shared/constants";
import { notFound } from "../../shared/errors";
import { groupMetricCandlesBySymbol, readMetricCandles } from "../market-data/market-data.candles";
import { getDateYearsAgo } from "../market-data/market-data.dates";
import {
  getActiveMemberInstrumentRows,
  requireCollectionByCode,
} from "../market-collections/market-collections.service";
import { getIsoWeekRange, getWeekEndingFriday } from "../market-data/trading-calendar";
import { resolveScannerSignalFromDailyCloses } from "../scanner/scanner-current-signal";
import {
  DEFAULT_SCANNER_LOOKBACK,
  SCANNER_LOOKBACK_WEEKS,
  type ScannerLookbackMultiplier,
} from "../scanner/scanner.constants";
import {
  CURRENT_MEMBERSHIP,
  DASHBOARD_BACKTEST_WEEKS,
  HISTORICAL_MEMBERSHIP,
  UNCLASSIFIED_SECTOR_LABEL,
  type WeeklyStrongBacktestMembershipMode,
} from "./weekly-strong-backtest.constants";

const MEMBERSHIP_CHANGES_FETCH_YEARS = 10;

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

  if (
    historicalRuns.length > 0 &&
    (currentRuns.length === 0 || historicalRuns.length >= currentRuns.length)
  ) {
    return {
      mode: HISTORICAL_MEMBERSHIP as WeeklyStrongBacktestMembershipMode,
      runs: historicalRuns,
    };
  }

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
  instrumentId: string;
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

function dedupeByInstrumentId<T extends { instrumentId: string }>(members: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const member of members) {
    if (seen.has(member.instrumentId)) continue;
    seen.add(member.instrumentId);
    deduped.push(member);
  }
  return deduped;
}

export function computeMembershipChanges<T extends WeeklyStrongBacktestMembershipChangeMember>(
  currentMembersInput: T[],
  previousMembersInput: T[] | null,
): { enteredStocks: T[]; exitedStocks: T[] } {
  const currentMembers = dedupeByInstrumentId(currentMembersInput);

  if (!previousMembersInput) {
    return { enteredStocks: currentMembers, exitedStocks: [] };
  }

  const previousMembers = dedupeByInstrumentId(previousMembersInput);
  const previousIds = new Set(previousMembers.map((member) => member.instrumentId));
  const currentIds = new Set(currentMembers.map((member) => member.instrumentId));

  return {
    enteredStocks: currentMembers.filter((member) => !previousIds.has(member.instrumentId)),
    exitedStocks: previousMembers.filter((member) => !currentIds.has(member.instrumentId)),
  };
}

// Stock Harvest membership is Scanner-driven (see market-data.metrics.ts's
// computeWeeklyStrongStocks) - Stocks In/Out must diff the same
// Scanner-qualified sets, not weeklyStrongBacktestRuns (a Weekly-Strong-
// specific persisted table this function never touches). Computed live from
// the collection's current active members and their candle history - no new
// table, no schema change - reusing computeMembershipChanges above (a pure
// instrumentId diff, agnostic to which evaluator produced its inputs) and
// resolveScannerSignalFromDailyCloses (the same Scanner chain the chart and
// Stock Harvest table use) for both the current AND the immediately
// preceding completed week's membership in one pass per symbol.
export async function getWeeklyStrongBacktestMembershipChanges(input: {
  code: string;
  weekEnding: string;
  lookback?: ScannerLookbackMultiplier;
}): Promise<WeeklyStrongBacktestMembershipChanges> {
  const collection = await requireCollectionByCode(input.code);
  const lookback = input.lookback ?? DEFAULT_SCANNER_LOOKBACK;
  const baseResponse = {
    collection: { code: collection.code, name: collection.name },
    membershipMode: CURRENT_MEMBERSHIP as WeeklyStrongBacktestMembershipMode,
  };

  const memberRows = await getActiveMemberInstrumentRows(collection.id);
  const unavailable = {
    ...baseResponse,
    available: false,
    weekEnding: null,
    previousWeekEnding: null,
    enteredStocks: [],
    exitedStocks: [],
  };
  if (memberRows.length === 0) return unavailable;

  const dailyCandles = await readMetricCandles({
    instruments: memberRows.map((row) => ({ instrumentId: row.instrumentId, symbol: row.symbol })),
    timeframe: CANDLE_TIMEFRAME.day,
    from: getDateYearsAgo(MEMBERSHIP_CHANGES_FETCH_YEARS),
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);

  let weekEnding: string | null = null;
  let previousWeekEnding: string | null = null;
  const currentMembers: WeeklyStrongBacktestMembershipChangeMember[] = [];
  const previousMembers: WeeklyStrongBacktestMembershipChangeMember[] = [];

  for (const member of memberRows) {
    const dailyRows = dailyCandlesBySymbol.get(member.symbol) ?? [];
    if (dailyRows.length === 0) continue;

    const signal = resolveScannerSignalFromDailyCloses(
      dailyRows.map((row) => ({ time: row.time, close: row.close })),
      collection.exchange,
      SCANNER_LOOKBACK_WEEKS[lookback],
    );

    if (signal.currentTime && !weekEnding) weekEnding = getWeekEndingFriday(signal.currentTime);
    if (signal.previousWeekTime && !previousWeekEnding) previousWeekEnding = getWeekEndingFriday(signal.previousWeekTime);

    const changeMember: WeeklyStrongBacktestMembershipChangeMember = {
      instrumentId: member.instrumentId,
      symbol: member.symbol,
      name: member.name,
      exchange: member.exchange,
    };
    if (signal.matched) currentMembers.push(changeMember);
    if (signal.previousWeekMatched) previousMembers.push(changeMember);
  }

  if (!weekEnding) return unavailable;
  if (getIsoWeekRange(input.weekEnding).start !== getIsoWeekRange(weekEnding).start) return unavailable;

  const { enteredStocks, exitedStocks } = computeMembershipChanges(
    currentMembers,
    previousWeekEnding ? previousMembers : null,
  );

  return {
    ...baseResponse,
    available: true,
    weekEnding,
    previousWeekEnding,
    enteredStocks,
    exitedStocks,
  };
}
