import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn() } }));
vi.mock("../market-collections/market-collections.service", () => ({
  requireCollectionByCode: vi.fn(),
}));

import * as dbClientModule from "../../db/client";
import { getWeekEndingFriday } from "../market-data/trading-calendar";
import * as marketCollectionsModule from "../market-collections/market-collections.service";
import {
  computeMembershipChanges,
  getWeeklyStrongBacktestMembershipChanges,
  type WeeklyStrongBacktestMembershipChangeMember,
} from "./weekly-strong-backtest.queries";

const db = vi.mocked(dbClientModule.db);
const requireCollectionByCode = vi.mocked(marketCollectionsModule.requireCollectionByCode);

function member(symbol: string, exchange = "NSE", instrumentId = `${exchange}:${symbol}`) {
  return { instrumentId, symbol, name: symbol, exchange };
}

// Mimics drizzle's chainable, awaitable query builder just enough for this
// file's queries (select/from/where/orderBy/limit, awaited at any point in
// the chain) - no real Postgres reachable in this environment.
function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

function assertInOutInvariants(
  current: WeeklyStrongBacktestMembershipChangeMember[],
  previous: WeeklyStrongBacktestMembershipChangeMember[],
  entered: WeeklyStrongBacktestMembershipChangeMember[],
  exited: WeeklyStrongBacktestMembershipChangeMember[],
) {
  const currentIds = new Set(current.map((m) => m.instrumentId));
  const previousIds = new Set(previous.map((m) => m.instrumentId));

  for (const stock of entered) {
    expect(currentIds.has(stock.instrumentId)).toBe(true);
    expect(previousIds.has(stock.instrumentId)).toBe(false);
  }
  for (const stock of exited) {
    expect(previousIds.has(stock.instrumentId)).toBe(true);
    expect(currentIds.has(stock.instrumentId)).toBe(false);
  }
}

describe("computeMembershipChanges", () => {
  it("A: identical membership -> no entries, no exits", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("A"), member("B"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([]);
    assertInOutInvariants(current, previous, enteredStocks, exitedStocks);
  });

  it("B: a new stock qualifies -> entered only", () => {
    const previous = [member("A"), member("B")];
    const current = [member("A"), member("B"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("C")]);
    expect(exitedStocks).toEqual([]);
  });

  it("C: a stock drops off -> exited only", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("A"), member("B")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([member("C")]);
  });

  it("D: the task's canonical example - previous [A,B,C], current [B,C,D] -> IN [D], OUT [A], B/C unchanged", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("B"), member("C"), member("D")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("D")]);
    expect(exitedStocks).toEqual([member("A")]);
    const changedIds = new Set([...enteredStocks, ...exitedStocks].map((m) => m.instrumentId));
    expect(changedIds.has(member("B").instrumentId)).toBe(false);
    expect(changedIds.has(member("C").instrumentId)).toBe(false);
    assertInOutInvariants(current, previous, enteredStocks, exitedStocks);
  });

  it("E: the same symbol on a different exchange is a distinct identity", () => {
    const previous = [member("TCS", "NSE")];
    const current = [member("TCS", "BSE")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("TCS", "BSE")]);
    expect(exitedStocks).toEqual([member("TCS", "NSE")]);
  });

  it("F: no previous result -> every current member counts as entered, nothing exits", () => {
    const current = [member("A"), member("B")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, null);

    expect(enteredStocks).toEqual(current);
    expect(exitedStocks).toEqual([]);
  });

  it("a previous run with zero members is not the same as no previous run - everything current still counts as entered", () => {
    const current = [member("A")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, []);

    expect(enteredStocks).toEqual([member("A")]);
    expect(exitedStocks).toEqual([]);
  });

  it("identical snapshots produce zero IN and zero OUT even with a larger overlapping set", () => {
    const stocks = [member("A"), member("B"), member("C"), member("D"), member("E")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(stocks, stocks);

    expect(enteredStocks).toHaveLength(0);
    expect(exitedStocks).toHaveLength(0);
  });

  it("duplicate rows for the same instrumentId do not create duplicate IN/OUT rows", () => {
    const previous = [member("A"), member("A"), member("B")];
    const current = [member("B"), member("C"), member("C"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("C")]);
    expect(exitedStocks).toEqual([member("A")]);
  });

  it("canonical instrumentId drives identity, not symbol text: a real rename (same instrumentId, new symbol) is unchanged", () => {
    const previous = [member("OLDNAME", "BSE", "instrument-1")];
    const current = [member("NEWNAME", "BSE", "instrument-1")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([]);
  });

  it("canonical instrumentId drives identity, not symbol text: two different instruments sharing a symbol are both entered and exited", () => {
    const previous = [member("TCS", "BSE", "instrument-old")];
    const current = [member("TCS", "BSE", "instrument-new")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("TCS", "BSE", "instrument-new")]);
    expect(exitedStocks).toEqual([member("TCS", "BSE", "instrument-old")]);
  });

  it("invariants hold across a larger mixed fixture", () => {
    const previous = [member("A"), member("B"), member("C"), member("D"), member("E")];
    const current = [member("C"), member("D"), member("E"), member("F"), member("G")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks.map((m) => m.symbol).sort()).toEqual(["F", "G"]);
    expect(exitedStocks.map((m) => m.symbol).sort()).toEqual(["A", "B"]);
    assertInOutInvariants(current, previous, enteredStocks, exitedStocks);
  });
});

describe("getWeeklyStrongBacktestMembershipChanges - anchored to the requested week", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCollectionByCode.mockResolvedValue({
      id: "col-1",
      code: "SEG1",
      name: "Segment One",
      exchange: "NSE",
    } as never);
  });

  it("A: the requested week matches the latest persisted run -> resolves that run and the one before it, both labeled by their week-ending Friday", async () => {
    db.select
      .mockReturnValueOnce(selectResult([])) // resolveMembershipMode: no historical runs -> current_membership
      .mockReturnValueOnce(selectResult([{ id: "run-2", weekEnding: "2026-09-01", totalPassing: 2 }])) // findRunForWeek (raw stored value - a Tuesday)
      .mockReturnValueOnce(selectResult([{ id: "run-1", weekEnding: "2026-08-25", totalPassing: 1 }])) // findPreviousRun (raw stored value)
      .mockReturnValueOnce(
        selectResult([
          { runId: "run-1", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" },
          { runId: "run-2", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" },
          { runId: "run-2", instrumentId: "id-b", symbol: "B", name: "Beta", exchange: "NSE" },
        ])
      );

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-09-04",
    });

    expect(result.available).toBe(true);
    expect(result.weekEnding).toBe(getWeekEndingFriday("2026-09-01"));
    expect(result.previousWeekEnding).toBe(getWeekEndingFriday("2026-08-25"));
    // The canonical example from the task: current week ending 04 Sep 2026,
    // previous week ending 28 Aug 2026.
    expect(result.weekEnding).toBe("2026-09-04");
    expect(result.previousWeekEnding).toBe("2026-08-28");
    expect(result.enteredStocks).toEqual([{ instrumentId: "id-b", symbol: "B", name: "Beta", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("B: the Harvest week is older than the Backtest's latest run -> the exact requested week is used, not the latest", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-old", weekEnding: "2026-08-18", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(
        selectResult([{ runId: "run-old", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" }])
      );

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-08-19",
    });

    // Matches the task's own example: a raw stored 2026-08-18 (Tuesday)
    // must surface as its week-ending Friday, 2026-08-21 - not 2026-08-18
    // itself, and not the unrelated latest run's own week.
    expect(result.weekEnding).toBe("2026-08-21");
    expect(result.weekEnding).toBe(getWeekEndingFriday("2026-08-18"));
    expect(result.weekEnding).not.toBe(getWeekEndingFriday("2026-09-01"));
  });

  it("C: the requested week has no persisted run -> unavailable, with no forward/backward fallback", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([])); // findRunForWeek: nothing in range

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-09-04",
    });

    expect(result.available).toBe(false);
    expect(result.weekEnding).toBeNull();
    expect(result.previousWeekEnding).toBeNull();
    expect(result.enteredStocks).toEqual([]);
    expect(result.exitedStocks).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("D: the previous week is resolved as the closest persisted run strictly before the requested week, never a later one", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-3", weekEnding: "2026-09-08", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([{ id: "run-2", weekEnding: "2026-09-01", totalPassing: 2 }]))
      .mockReturnValueOnce(
        selectResult([{ runId: "run-3", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" }])
      );

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-09-10",
    });

    expect(result.weekEnding).toBe(getWeekEndingFriday("2026-09-08"));
    expect(result.previousWeekEnding).toBe(getWeekEndingFriday("2026-09-01"));
    expect(result.weekEnding).toBe("2026-09-11");
    expect(result.previousWeekEnding).toBe("2026-09-04");
    // Current must always be strictly newer than previous - never equal, never reversed.
    expect(new Date(result.weekEnding as string).getTime()).toBeGreaterThan(
      new Date(result.previousWeekEnding as string).getTime()
    );
  });

  it("E: findPreviousRun is called with the current run's own weekEnding, not a hardcoded/reversed direction - the query filter proves the ordering cannot silently invert", async () => {
    const whereSpy = vi.fn().mockReturnValue({
      orderBy: () => ({ limit: () => Promise.resolve([{ id: "run-1", weekEnding: "2026-08-25", totalPassing: 1 }]) }),
    });
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-2", weekEnding: "2026-09-01", totalPassing: 2 }]))
      .mockReturnValueOnce({ from: () => ({ where: whereSpy }) } as never)
      .mockReturnValueOnce(selectResult([]));

    await getWeeklyStrongBacktestMembershipChanges({ code: "SEG1", weekEnding: "2026-09-04" });

    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it("no earlier run exists at all -> previousWeekEnding is null and every current member counts as entered", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-1", weekEnding: "2026-08-25", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([])) // findPreviousRun: nothing before it
      .mockReturnValueOnce(
        selectResult([{ runId: "run-1", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" }])
      );

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-08-28",
    });

    expect(result.previousWeekEnding).toBeNull();
    expect(result.enteredStocks).toEqual([{ instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("duplicate member rows for the same instrumentId within one run do not duplicate entered/exited results", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-2", weekEnding: "2026-09-01", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([{ id: "run-1", weekEnding: "2026-08-25", totalPassing: 1 }]))
      .mockReturnValueOnce(
        selectResult([
          { runId: "run-1", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" },
          { runId: "run-1", instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" },
          { runId: "run-2", instrumentId: "id-b", symbol: "B", name: "Beta", exchange: "NSE" },
          { runId: "run-2", instrumentId: "id-b", symbol: "B", name: "Beta", exchange: "NSE" },
        ])
      );

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-09-04",
    });

    expect(result.enteredStocks).toEqual([{ instrumentId: "id-b", symbol: "B", name: "Beta", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([{ instrumentId: "id-a", symbol: "A", name: "Alpha", exchange: "NSE" }]);
  });
});
