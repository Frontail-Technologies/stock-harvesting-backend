import { eq } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { weeklyStrongBacktestMembers, weeklyStrongBacktestRuns } from "../../db/schema";
import type { WeeklyStrongBacktestWeekMembers } from "../market-data/market-data.service";
import { WEEKLY_STRONG_EVALUATOR_VERSION } from "../market-data/weekly-strong-evaluator";
import type { WeeklyStrongBacktestMembershipMode } from "./weekly-strong-backtest.constants";

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

    await tx
      .delete(weeklyStrongBacktestMembers)
      .where(eq(weeklyStrongBacktestMembers.runId, run.id));

    const memberValues = point.passing
      .map((member) => {
        const instrumentId = instrumentIdBySymbol.get(member.symbol);
        if (!instrumentId) return null;
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
