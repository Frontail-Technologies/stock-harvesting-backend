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
} from "./weekly-strong-backtest.queries";

const db = vi.mocked(dbClientModule.db);
const requireCollectionByCode = vi.mocked(marketCollectionsModule.requireCollectionByCode);

function member(symbol: string, exchange = "NSE") {
  return { symbol, name: symbol, exchange };
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

describe("computeMembershipChanges", () => {
  it("A: identical membership -> no entries, no exits", () => {
    const previous = [member("A"), member("B"), member("C")];
    const current = [member("A"), member("B"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([]);
    expect(exitedStocks).toEqual([]);
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

  it("D: one enters and one exits in the same week", () => {
    const previous = [member("A"), member("B")];
    const current = [member("B"), member("C")];

    const { enteredStocks, exitedStocks } = computeMembershipChanges(current, previous);

    expect(enteredStocks).toEqual([member("C")]);
    expect(exitedStocks).toEqual([member("A")]);
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
          { runId: "run-1", symbol: "A", name: "Alpha", exchange: "NSE" },
          { runId: "run-2", symbol: "A", name: "Alpha", exchange: "NSE" },
          { runId: "run-2", symbol: "B", name: "Beta", exchange: "NSE" },
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
    expect(result.enteredStocks).toEqual([{ symbol: "B", name: "Beta", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([]);
  });

  it("B: the Harvest week is older than the Backtest's latest run -> the exact requested week is used, not the latest", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-old", weekEnding: "2026-08-18", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ runId: "run-old", symbol: "A", name: "Alpha", exchange: "NSE" }]));

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

  it("D: the previous week is resolved as the closest persisted run strictly before the requested week", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-3", weekEnding: "2026-09-08", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([{ id: "run-2", weekEnding: "2026-09-01", totalPassing: 2 }]))
      .mockReturnValueOnce(selectResult([{ runId: "run-3", symbol: "A", name: "Alpha", exchange: "NSE" }]));

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-09-10",
    });

    expect(result.weekEnding).toBe(getWeekEndingFriday("2026-09-08"));
    expect(result.previousWeekEnding).toBe(getWeekEndingFriday("2026-09-01"));
    expect(result.weekEnding).toBe("2026-09-11");
    expect(result.previousWeekEnding).toBe("2026-09-04");
  });

  it("no earlier run exists at all -> previousWeekEnding is null and every current member counts as entered", async () => {
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "run-1", weekEnding: "2026-08-25", totalPassing: 1 }]))
      .mockReturnValueOnce(selectResult([])) // findPreviousRun: nothing before it
      .mockReturnValueOnce(selectResult([{ runId: "run-1", symbol: "A", name: "Alpha", exchange: "NSE" }]));

    const result = await getWeeklyStrongBacktestMembershipChanges({
      code: "SEG1",
      weekEnding: "2026-08-28",
    });

    expect(result.previousWeekEnding).toBeNull();
    expect(result.enteredStocks).toEqual([{ symbol: "A", name: "Alpha", exchange: "NSE" }]);
    expect(result.exitedStocks).toEqual([]);
  });
});
