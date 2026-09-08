import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the weekly_strong snapshot cache-freshness fix: a row cached
 * under an older snapshot shape (e.g. one written before returnPct
 * existed) must be treated as a miss and recomputed once - not served
 * as-is just because *some* cached row exists, and not confused with a
 * modern row whose returnPct is a genuine `null`. relative_strength's own
 * version-check (already correct before this fix) isn't re-tested here.
 *
 * dashboard-snapshot-store.ts and market-data.service.ts are mocked -
 * this proves ORCHESTRATION (does a version mismatch trigger exactly one
 * recompute + persist, does a version match skip both), not the real DB
 * or the evaluator's own decision logic.
 */

vi.mock("./market-data.service", () => ({
  computeWeeklyStrongStocks: vi.fn(),
  computeAllRelativeStrengthMetrics: vi.fn(),
}));

vi.mock("./dashboard-snapshot-store", async () => {
  const actual = await vi.importActual<
    typeof import("./dashboard-snapshot-store")
  >("./dashboard-snapshot-store");
  return {
    ...actual,
    readDashboardSnapshotWithMeta: vi.fn(),
    writeDashboardSnapshot: vi.fn(),
  };
});

import * as marketDataServiceModule from "./market-data.service";
import * as snapshotStoreModule from "./dashboard-snapshot-store";
import { WEEKLY_STRONG_SNAPSHOT_VERSION } from "./dashboard-snapshot-store";
import { getOrComputeWeeklyStrongSnapshot } from "./dashboard-snapshots.service";
import type { WeeklyStrongStockRow } from "./market-data.metrics";
import { resolveCompletedWeekEndingFromTradingDay } from "./trading-calendar";

const computeWeeklyStrongStocks = vi.mocked(
  marketDataServiceModule.computeWeeklyStrongStocks,
);
const readDashboardSnapshotWithMeta = vi.mocked(
  snapshotStoreModule.readDashboardSnapshotWithMeta,
);
const writeDashboardSnapshot = vi.mocked(
  snapshotStoreModule.writeDashboardSnapshot,
);

const MEMBER_ROWS = [{ symbol: "AAA", name: "Alpha Co", exchange: "NSE" }];

function buildRow(
  overrides: Partial<WeeklyStrongStockRow> = {},
): WeeklyStrongStockRow {
  return {
    symbol: "AAA",
    name: "Alpha Co",
    exchange: "NSE",
    close: 100,
    changePct: 1.5,
    returnPct: 12.5,
    volume: 1000,
    sector: null,
    industry: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeDashboardSnapshot.mockResolvedValue({ asOfDate: "2024-01-01" });
});

describe("getOrComputeWeeklyStrongSnapshot - cache freshness", () => {
  it("A: a legacy cached row (older snapshot version, missing returnPct) is treated as a miss and recomputed", async () => {
    readDashboardSnapshotWithMeta.mockResolvedValueOnce({
      payload: [
        {
          symbol: "AAA",
          name: "Alpha Co",
          exchange: "NSE",
          close: 100,
          changePct: 1.5,
          volume: 1000,
          sector: null,
          industry: null,
        },
      ] as unknown as WeeklyStrongStockRow[],
      asOfDate: "2023-01-01",
      evaluatorVersion: "weekly-strong-v1",
    });
    const fresh = [buildRow()];
    computeWeeklyStrongStocks.mockResolvedValueOnce(fresh);

    const result = await getOrComputeWeeklyStrongSnapshot(
      "col-1",
      "NSE",
      MEMBER_ROWS,
    );

    expect(computeWeeklyStrongStocks).toHaveBeenCalledTimes(1);
    expect(computeWeeklyStrongStocks).toHaveBeenCalledWith(MEMBER_ROWS, "NSE");
    expect(writeDashboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluatorVersion: WEEKLY_STRONG_SNAPSHOT_VERSION,
        payload: fresh,
      }),
    );
    expect(result.items).toEqual(fresh);
    expect(result.weekEnding).toBe(resolveCompletedWeekEndingFromTradingDay("2024-01-01"));
  });

  it("B: a modern cached row with returnPct: null is served as-is - null is a valid result, not a staleness signal", async () => {
    const cachedRows = [buildRow({ returnPct: null })];
    readDashboardSnapshotWithMeta.mockResolvedValueOnce({
      payload: cachedRows,
      asOfDate: "2024-06-01",
      evaluatorVersion: WEEKLY_STRONG_SNAPSHOT_VERSION,
    });

    const result = await getOrComputeWeeklyStrongSnapshot(
      "col-2",
      "NSE",
      MEMBER_ROWS,
    );

    expect(computeWeeklyStrongStocks).not.toHaveBeenCalled();
    expect(writeDashboardSnapshot).not.toHaveBeenCalled();
    expect(result.items).toEqual(cachedRows);
    expect(result.items[0].returnPct).toBeNull();
    expect(result.weekEnding).toBe(resolveCompletedWeekEndingFromTradingDay("2024-06-01"));
  });

  it("C: a modern cached row with a numeric returnPct is served as-is", async () => {
    const cachedRows = [buildRow({ returnPct: 8.42 })];
    readDashboardSnapshotWithMeta.mockResolvedValueOnce({
      payload: cachedRows,
      asOfDate: "2024-06-01",
      evaluatorVersion: WEEKLY_STRONG_SNAPSHOT_VERSION,
    });

    const result = await getOrComputeWeeklyStrongSnapshot(
      "col-3",
      "NSE",
      MEMBER_ROWS,
    );

    expect(computeWeeklyStrongStocks).not.toHaveBeenCalled();
    expect(writeDashboardSnapshot).not.toHaveBeenCalled();
    expect(result.items).toEqual(cachedRows);
  });

  it("D: recomputation calls computeWeeklyStrongStocks exactly once for the whole member pool, never once per stock", async () => {
    const manyMembers = Array.from({ length: 25 }, (_, i) => ({
      symbol: `SYM${i}`,
      name: `Company ${i}`,
      exchange: "NSE",
    }));
    readDashboardSnapshotWithMeta.mockResolvedValueOnce(null);
    computeWeeklyStrongStocks.mockResolvedValueOnce(
      manyMembers.map((m) => buildRow({ symbol: m.symbol })),
    );

    await getOrComputeWeeklyStrongSnapshot("col-4", "NSE", manyMembers);

    expect(computeWeeklyStrongStocks).toHaveBeenCalledTimes(1);
    expect(computeWeeklyStrongStocks).toHaveBeenCalledWith(manyMembers, "NSE");
  });

  it("no cached row at all is also treated as a miss and recomputed", async () => {
    readDashboardSnapshotWithMeta.mockResolvedValueOnce(null);
    const fresh = [buildRow()];
    computeWeeklyStrongStocks.mockResolvedValueOnce(fresh);

    const result = await getOrComputeWeeklyStrongSnapshot(
      "col-5",
      "NSE",
      MEMBER_ROWS,
    );

    expect(computeWeeklyStrongStocks).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual(fresh);
  });
});
