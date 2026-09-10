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
import {
  RELATIVE_STRENGTH_SNAPSHOT_VERSION,
  WEEKLY_STRONG_SNAPSHOT_VERSION,
} from "./dashboard-snapshot-store";
import {
  getOrComputeCollectionRelativeStrengthBase,
  getOrComputeWeeklyStrongSnapshot,
} from "./dashboard-snapshots.service";
import {
  deriveSectorIndustryTaxonomy,
  groupRelativeStrengthMetrics,
  type RelativeStrengthMetricRow,
  type WeeklyStrongStockRow,
} from "./market-data.metrics";
import { resolveCompletedWeekEndingFromTradingDay } from "./trading-calendar";

const computeWeeklyStrongStocks = vi.mocked(
  marketDataServiceModule.computeWeeklyStrongStocks,
);
const computeAllRelativeStrengthMetrics = vi.mocked(
  marketDataServiceModule.computeAllRelativeStrengthMetrics,
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
    inSince: "2026-08-14",
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

/**
 * Regression for the "Sector Harvest / Industry Harvest empty" production bug:
 * a relative_strength snapshot written BEFORE sector-classification sync froze
 * every row's sector/industry as null. The version tag never changed and
 * nothing invalidates the snapshot on classification sync, so the stale
 * payload stayed authoritative and both group aggregations (which derive from
 * this one base) rendered empty even though instruments.sector/industry were
 * now populated. The fix re-projects current taxonomy from the live member
 * rows on every cache hit.
 */
describe("getOrComputeCollectionRelativeStrengthBase - stale frozen taxonomy", () => {
  function rsRow(overrides: Partial<RelativeStrengthMetricRow>): RelativeStrengthMetricRow {
    return {
      symbol: "SYM",
      name: "Sym Co",
      exchange: "BSE",
      sector: null,
      industry: null,
      close: 100,
      volume: 1000,
      change55dPct: 0,
      ...overrides,
    };
  }

  // Frozen snapshot payload: taxonomy is all null (written pre-classification).
  const STALE_PAYLOAD: RelativeStrengthMetricRow[] = [
    rsRow({ symbol: "ADANIPORTS", name: "Adani Ports", change55dPct: 15, close: 1400 }),
    rsRow({ symbol: "AXISBANK", name: "Axis Bank", change55dPct: 8, close: 1100 }),
    rsRow({ symbol: "COFORGE", name: "Coforge", change55dPct: 22, close: 6200 }),
    rsRow({ symbol: "UNCLASSIFIED", name: "Newly Listed", change55dPct: 3, close: 90 }),
  ];

  // Current instruments: classification sync has since populated 3 of 4.
  const MEMBER_ROWS_WITH_TAXONOMY = [
    { symbol: "ADANIPORTS", name: "Adani Ports", exchange: "BSE", sector: "Services", industry: "Transport Infrastructure" },
    { symbol: "AXISBANK", name: "Axis Bank", exchange: "BSE", sector: "Financial Services", industry: "Banks" },
    { symbol: "COFORGE", name: "Coforge", exchange: "BSE", sector: "Information Technology", industry: "IT - Software" },
    { symbol: "UNCLASSIFIED", name: "Newly Listed", exchange: "BSE", sector: null, industry: null },
  ];

  beforeEach(() => {
    readDashboardSnapshotWithMeta.mockResolvedValue({
      payload: STALE_PAYLOAD,
      asOfDate: "2026-09-08",
      evaluatorVersion: RELATIVE_STRENGTH_SNAPSHOT_VERSION,
    });
  });

  it("re-projects current sector/industry from the live member rows onto a stale cache hit", async () => {
    const { metrics, asOfDate } = await getOrComputeCollectionRelativeStrengthBase(
      "col-bse100",
      "BSE",
      MEMBER_ROWS_WITH_TAXONOMY,
    );

    // No recompute / rewrite - this is a pure read-boundary projection.
    expect(computeAllRelativeStrengthMetrics).not.toHaveBeenCalled();
    expect(writeDashboardSnapshot).not.toHaveBeenCalled();
    expect(asOfDate).toBe("2026-09-08");

    const bySymbol = Object.fromEntries(metrics.map((m) => [m.symbol, m]));
    expect(bySymbol.ADANIPORTS.sector).toBe("Services");
    expect(bySymbol.ADANIPORTS.industry).toBe("Transport Infrastructure");
    expect(bySymbol.AXISBANK.sector).toBe("Financial Services");
    expect(bySymbol.COFORGE.sector).toBe("Information Technology");
  });

  it("makes Sector and Industry aggregation non-empty again", async () => {
    const { metrics } = await getOrComputeCollectionRelativeStrengthBase(
      "col-bse100",
      "BSE",
      MEMBER_ROWS_WITH_TAXONOMY,
    );

    const sectorGroups = groupRelativeStrengthMetrics(metrics, "sector", 50);
    const industryGroups = groupRelativeStrengthMetrics(metrics, "industry", 50);
    const taxonomy = deriveSectorIndustryTaxonomy(metrics);

    expect(sectorGroups.map((g) => g.label).sort()).toEqual([
      "Financial Services",
      "Information Technology",
      "Services",
    ]);
    expect(industryGroups.length).toBe(3);
    expect(taxonomy.find((t) => t.sector === "Information Technology")?.industries).toEqual([
      "IT - Software",
    ]);
  });

  it("leaves a genuinely unclassified instrument null and safely excluded from aggregation", async () => {
    const { metrics } = await getOrComputeCollectionRelativeStrengthBase(
      "col-bse100",
      "BSE",
      MEMBER_ROWS_WITH_TAXONOMY,
    );

    const unclassified = metrics.find((m) => m.symbol === "UNCLASSIFIED");
    expect(unclassified?.sector).toBeNull();
    expect(unclassified?.industry).toBeNull();

    const sectorGroups = groupRelativeStrengthMetrics(metrics, "sector", 50);
    expect(sectorGroups.some((g) => g.label.includes("nclassified"))).toBe(false);
    expect(sectorGroups.reduce((n, g) => n + g.memberCount, 0)).toBe(3);
  });

  it("does not change metric values, ordering, or Relative Strength semantics", async () => {
    const { metrics } = await getOrComputeCollectionRelativeStrengthBase(
      "col-bse100",
      "BSE",
      MEMBER_ROWS_WITH_TAXONOMY,
    );

    expect(metrics.map((m) => m.symbol)).toEqual(
      STALE_PAYLOAD.map((m) => m.symbol),
    );
    for (let i = 0; i < metrics.length; i++) {
      expect(metrics[i].change55dPct).toBe(STALE_PAYLOAD[i].change55dPct);
      expect(metrics[i].close).toBe(STALE_PAYLOAD[i].close);
      expect(metrics[i].volume).toBe(STALE_PAYLOAD[i].volume);
      expect(metrics[i].name).toBe(STALE_PAYLOAD[i].name);
    }
  });

  it("returns the payload untouched when the cached taxonomy already matches current instruments", async () => {
    const freshPayload = STALE_PAYLOAD.map((row, i) => ({
      ...row,
      sector: MEMBER_ROWS_WITH_TAXONOMY[i].sector,
      industry: MEMBER_ROWS_WITH_TAXONOMY[i].industry,
    }));
    readDashboardSnapshotWithMeta.mockResolvedValue({
      payload: freshPayload,
      asOfDate: "2026-09-09",
      evaluatorVersion: RELATIVE_STRENGTH_SNAPSHOT_VERSION,
    });

    const { metrics } = await getOrComputeCollectionRelativeStrengthBase(
      "col-bse100",
      "BSE",
      MEMBER_ROWS_WITH_TAXONOMY,
    );

    expect(metrics).toBe(freshPayload);
  });

  it("does not touch a cached row whose symbol is no longer an active member", async () => {
    readDashboardSnapshotWithMeta.mockResolvedValue({
      payload: [rsRow({ symbol: "REMOVED", sector: "Old Sector", industry: "Old Industry" })],
      asOfDate: "2026-09-08",
      evaluatorVersion: RELATIVE_STRENGTH_SNAPSHOT_VERSION,
    });

    const { metrics } = await getOrComputeCollectionRelativeStrengthBase(
      "col-bse100",
      "BSE",
      MEMBER_ROWS_WITH_TAXONOMY,
    );

    expect(metrics[0].sector).toBe("Old Sector");
    expect(metrics[0].industry).toBe("Old Industry");
  });
});
