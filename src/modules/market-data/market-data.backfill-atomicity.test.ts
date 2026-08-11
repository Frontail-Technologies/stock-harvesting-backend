import { describe, expect, it } from "vitest";

import type { DbOrTx } from "../../db/client";
import { replaceCandlesAtomically } from "./market-data.service";

/**
 * No Postgres instance is reachable in this environment (verified before
 * writing this file), so this can't be a true integration test that proves
 * Postgres itself rolls back a failed transaction — that guarantee is
 * Postgres's own, not this codebase's. What *is* ours to prove, and what
 * this test proves: replaceCandlesAtomically routes every write through a
 * single `dbClient.transaction(...)` call, so a failure partway through
 * (here: the weekly-candle upsert) never reaches a "committed" state — the
 * delete and the daily upsert that already ran are discarded along with it.
 *
 * The fake below models exactly that transaction semantic: writes go into a
 * `pending` copy, and `committed` is only replaced by `pending` if the
 * callback resolves. A thrown error skips that reassignment entirely.
 */

type FakeCandleRow = {
  exchange: string;
  symbol: string;
  timeframe: string;
  time: string;
  close: string;
};

function createFakeDb(seedRows: FakeCandleRow[]) {
  let committed = [...seedRows];
  let transactionCount = 0;

  const runInsert = (pending: FakeCandleRow[], rows: FakeCandleRow[], failTimeframe?: string) => {
    for (const row of rows) {
      if (failTimeframe && row.timeframe === failTimeframe) {
        throw new Error(`simulated upsert failure for timeframe ${failTimeframe}`);
      }
      const index = pending.findIndex(
        (existing) =>
          existing.exchange === row.exchange &&
          existing.symbol === row.symbol &&
          existing.timeframe === row.timeframe &&
          existing.time === row.time
      );
      if (index >= 0) pending[index] = row;
      else pending.push(row);
    }
  };

  function makeTx(pending: FakeCandleRow[], failTimeframe?: string) {
    return {
      delete: (_table: unknown) => ({
        where: async (_condition: unknown) => {
          pending.length = 0;
        },
      }),
      insert: (_table: unknown) => ({
        values: (rows: FakeCandleRow[]) => ({
          onConflictDoUpdate: (_options: unknown) => ({
            returning: async (_shape: unknown) => {
              runInsert(pending, rows, failTimeframe);
              return rows.map(() => ({ wasInsert: true }));
            },
          }),
        }),
      }),
    };
  }

  const fakeDb = {
    transaction: async (callback: (tx: unknown) => Promise<void>, failTimeframe?: string) => {
      transactionCount += 1;
      const pending = [...committed];
      await callback(makeTx(pending, failTimeframe));
      // Only reached if the callback above didn't throw — mirrors a real
      // COMMIT only happening after every statement in the transaction
      // succeeds.
      committed = pending;
    },
  };

  return {
    fakeDb,
    getCommitted: () => committed,
    getTransactionCount: () => transactionCount,
  };
}

// The real dbClient.transaction(cb) signature takes one argument; we sneak
// an extra "failTimeframe" through a second argument on our fake only, by
// having replaceCandlesAtomically's dbClient.transaction call forwarded
// as-is — see the wrapper below.
function withFailure(fakeDb: ReturnType<typeof createFakeDb>["fakeDb"], failTimeframe: string) {
  return {
    transaction: (callback: (tx: unknown) => Promise<void>) =>
      fakeDb.transaction(callback, failTimeframe),
  };
}

const existingCandle: FakeCandleRow = {
  exchange: "NSE",
  symbol: "RELIANCE",
  timeframe: "1D",
  time: "2026-01-01",
  close: "2500.0000",
};

const replacementDaily = [
  { time: "2026-01-02", open: 2500, high: 2550, low: 2490, close: 2540, volume: 1000 },
];
const replacementWeekly = [
  { time: "2026-01-02", open: 2500, high: 2550, low: 2490, close: 2540, volume: 1000 },
];
const replacementMonthly = [
  { time: "2026-01-02", open: 2500, high: 2550, low: 2490, close: 2540, volume: 1000 },
];

describe("replaceCandlesAtomically", () => {
  it("commits the delete and all 3 upserts together on success", async () => {
    const { fakeDb, getCommitted } = createFakeDb([existingCandle]);

    await replaceCandlesAtomically(fakeDb as unknown as DbOrTx, {
      instrumentId: "instrument-1",
      exchange: "NSE",
      symbol: "RELIANCE",
      from: "2026-01-01",
      to: "2026-01-31",
      daily: replacementDaily,
      weekly: replacementWeekly,
      monthly: replacementMonthly,
    });

    const committed = getCommitted();
    expect(committed.some((row) => row.time === "2026-01-01")).toBe(false);
    expect(committed.some((row) => row.timeframe === "1D" && row.time === "2026-01-02")).toBe(
      true
    );
    expect(committed.some((row) => row.timeframe === "1W")).toBe(true);
    expect(committed.some((row) => row.timeframe === "1M")).toBe(true);
  });

  it("leaves old candles untouched if a replacement upsert fails partway through", async () => {
    const { fakeDb, getCommitted } = createFakeDb([existingCandle]);
    const failingDb = withFailure(fakeDb, "1W");

    await expect(
      replaceCandlesAtomically(failingDb as unknown as DbOrTx, {
        instrumentId: "instrument-1",
        exchange: "NSE",
        symbol: "RELIANCE",
        from: "2026-01-01",
        to: "2026-01-31",
        daily: replacementDaily,
        weekly: replacementWeekly,
        monthly: replacementMonthly,
      })
    ).rejects.toThrow("simulated upsert failure for timeframe 1W");

    // The delete and the daily upsert both ran before the weekly upsert
    // threw, but neither is visible afterward — the original row is
    // exactly as it was, proving the whole sequence rolled back as one
    // unit rather than leaving a half-replaced range.
    const committed = getCommitted();
    expect(committed).toEqual([existingCandle]);
  });
});
