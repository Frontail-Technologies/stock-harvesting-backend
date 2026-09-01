import { describe, expect, it } from "vitest";

import type { DbOrTx } from "../../db/client";
import { weeklyStrongBacktestMembers, weeklyStrongBacktestRuns } from "../../db/schema";
import type { WeeklyStrongBacktestWeekMembers } from "../market-data/market-data.service";
import { persistWeeklyStrongBacktestWeek } from "./weekly-strong-backtest.service";

/**
 * No Postgres instance is reachable in this environment (same constraint as
 * market-data.backfill-atomicity.test.ts, which this fake's shape follows).
 * What this proves: persistWeeklyStrongBacktestWeek's own idempotency
 * contract - rerunning the same (collectionId, weekEnding, membershipMode)
 * updates the existing run in place (never a duplicate run row, via the
 * onConflictDoUpdate target matching the real unique constraint) and always
 * fully replaces that run's member set (delete-then-insert, never a partial
 * merge of old and new members) - not that Postgres itself enforces the
 * unique constraint or foreign keys, which is Postgres's own guarantee.
 */

type FakeRun = {
  id: string;
  collectionId: string;
  weekEnding: string;
  membershipMode: string;
  membershipVersionId: string | null;
  evaluatorVersion: string;
  totalPassing: number;
};
type FakeMember = {
  id: string;
  runId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
};

function createFakeDb() {
  const runs: FakeRun[] = [];
  const members: FakeMember[] = [];
  let runIdCounter = 0;
  let memberIdCounter = 0;

  function makeTx() {
    let lastRunId: string | null = null;

    return {
      insert(table: unknown) {
        if (table === weeklyStrongBacktestRuns) {
          return {
            values(row: Omit<FakeRun, "id">) {
              return {
                onConflictDoUpdate(options: { set: Partial<FakeRun> }) {
                  return {
                    async returning() {
                      const existing = runs.find(
                        (r) =>
                          r.collectionId === row.collectionId &&
                          r.weekEnding === row.weekEnding &&
                          r.membershipMode === row.membershipMode
                      );
                      if (existing) {
                        Object.assign(existing, options.set);
                        lastRunId = existing.id;
                        return [existing];
                      }
                      const created: FakeRun = { id: `run-${++runIdCounter}`, ...row };
                      runs.push(created);
                      lastRunId = created.id;
                      return [created];
                    },
                  };
                },
              };
            },
          };
        }
        if (table === weeklyStrongBacktestMembers) {
          return {
            async values(rows: Omit<FakeMember, "id">[]) {
              for (const row of rows) members.push({ id: `member-${++memberIdCounter}`, ...row });
            },
          };
        }
        throw new Error("unexpected table passed to fake insert()");
      },
      delete(table: unknown) {
        if (table === weeklyStrongBacktestMembers) {
          return {
            async where(_condition: unknown) {
              // Real code always deletes by eq(runId, <the just-upserted run's id>)
              // - lastRunId tracks exactly that within this fake transaction.
              for (let i = members.length - 1; i >= 0; i--) {
                if (members[i].runId === lastRunId) members.splice(i, 1);
              }
            },
          };
        }
        throw new Error("unexpected table passed to fake delete()");
      },
    };
  }

  const fakeDb = {
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      await callback(makeTx());
    },
  };

  return { fakeDb, getRuns: () => runs, getMembers: () => members };
}

const collectionId = "collection-1";
const instrumentIdBySymbol = new Map([
  ["TCS", "instrument-tcs"],
  ["RELIANCE", "instrument-reliance"],
]);

function weekPoint(time: string, symbols: string[]): WeeklyStrongBacktestWeekMembers {
  return {
    time,
    passing: symbols.map((symbol) => ({
      symbol,
      name: symbol,
      exchange: "BSE",
      sector: "Technology",
      industry: null,
    })),
  };
}

describe("persistWeeklyStrongBacktestWeek", () => {
  it("creates one run row and one member row per passing symbol on first generation", async () => {
    const { fakeDb, getRuns, getMembers } = createFakeDb();

    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["TCS", "RELIANCE"]),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );

    expect(getRuns()).toHaveLength(1);
    expect(getRuns()[0]).toMatchObject({
      collectionId,
      weekEnding: "2024-01-05",
      membershipMode: "current_membership",
      totalPassing: 2,
    });
    expect(getMembers()).toHaveLength(2);
    expect(getMembers().map((m) => m.symbol).sort()).toEqual(["RELIANCE", "TCS"]);
  });

  it("regenerating the same week updates the existing run in place rather than creating a second one (idempotent upsert)", async () => {
    const { fakeDb, getRuns } = createFakeDb();

    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["TCS"]),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );
    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["TCS", "RELIANCE"]),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );

    expect(getRuns()).toHaveLength(1);
    expect(getRuns()[0].totalPassing).toBe(2);
  });

  it("regeneration fully replaces the member set - a symbol that no longer passes is not left behind", async () => {
    const { fakeDb, getMembers } = createFakeDb();

    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["TCS", "RELIANCE"]),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );
    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["TCS"]),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );

    const members = getMembers();
    expect(members).toHaveLength(1);
    expect(members[0].symbol).toBe("TCS");
  });

  it("current_membership and historical_membership runs for the same week are two independent rows, not one blended row", async () => {
    const { fakeDb, getRuns } = createFakeDb();

    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["TCS"]),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );
    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", ["RELIANCE"]),
      instrumentIdBySymbol,
      { mode: "historical_membership", versionId: "version-a" },
      fakeDb as unknown as DbOrTx
    );

    const runs = getRuns();
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.membershipMode === "current_membership")?.totalPassing).toBe(1);
    expect(runs.find((r) => r.membershipMode === "historical_membership")?.totalPassing).toBe(1);
  });

  it("a week with zero passing members persists a run row with totalPassing 0 and no member rows", async () => {
    const { fakeDb, getRuns, getMembers } = createFakeDb();

    await persistWeeklyStrongBacktestWeek(
      collectionId,
      weekPoint("2024-01-05", []),
      instrumentIdBySymbol,
      { mode: "current_membership", versionId: null },
      fakeDb as unknown as DbOrTx
    );

    expect(getRuns()).toHaveLength(1);
    expect(getRuns()[0].totalPassing).toBe(0);
    expect(getMembers()).toHaveLength(0);
  });
});
