import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the analytical data-preparation/orchestration moved into this
 * module in Phase 9. Existing coverage (market-data.55-day-change.test.ts,
 * weekly-strong-evaluator.test.ts, near-250-week-high.test.ts) already
 * proves the 55-day formula and the Weekly Strong evaluator's own rules -
 * this file does NOT re-test those. It proves ORCHESTRATION: which candles
 * get fetched under which conditions (empty input, seed-backfill fallback),
 * how they're grouped/gated before reaching the evaluator, and that the
 * canonical evaluator functions are genuinely called (not reimplemented)
 * rather than asserting a function merely moved.
 *
 * readMetricCandles (the actual DB read, in market-data.candles.ts) and
 * safeProviderAction/backfillDailyCandles (provider-backed, in
 * market-data.candle-sync.ts) are mocked - same vi.mock technique used in
 * Phase 7B1/7B2/8's test files. The pure candle-shaping helpers
 * (filterMetricCandlesFrom/groupMetricCandlesBySymbol/
 * deriveWeeklyMetricCandlesFromDaily) and the Weekly Strong gating helpers
 * (excludeIncompleteTradingWeek/hasSufficientWeeklyStrongHistory) run for
 * real - they're prep/gating, not the proprietary decision itself.
 */

vi.mock("./market-data.candles", async () => {
  const actual = await vi.importActual<typeof import("./market-data.candles")>("./market-data.candles");
  return { ...actual, readMetricCandles: vi.fn() };
});

vi.mock("./market-data.candle-sync", () => ({
  safeProviderAction: vi.fn(),
  backfillDailyCandles: vi.fn(),
}));

vi.mock("./weekly-strong-evaluator", async () => {
  const actual = await vi.importActual<typeof import("./weekly-strong-evaluator")>("./weekly-strong-evaluator");
  return { ...actual, evaluateWeeklyStrongLatest: vi.fn() };
});

import * as candlesModule from "./market-data.candles";
import { deriveWeeklyMetricCandlesFromDaily } from "./market-data.candles";
import * as candleSyncModule from "./market-data.candle-sync";
import * as evaluatorModule from "./weekly-strong-evaluator";
import {
  computeAllRelativeStrengthMetrics,
  computeWeeklyStrongStocks,
  deriveSectorIndustryTaxonomy,
  getSymbolWeeklyStrongSeriesInput,
  readDailyAndWeeklyMetricCandles,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
} from "./market-data.metrics";

const readMetricCandles = vi.mocked(candlesModule.readMetricCandles);
const safeProviderAction = vi.mocked(candleSyncModule.safeProviderAction);
const backfillDailyCandles = vi.mocked(candleSyncModule.backfillDailyCandles);
const evaluateWeeklyStrongLatest = vi.mocked(evaluatorModule.evaluateWeeklyStrongLatest);

type FakeCandle = { symbol: string; time: string; open: number; high: number; low: number; close: number; volume: number };

// Generates `count` consecutive daily rows ending TODAY (ascending order,
// oldest first) - so they fall inside every lookback window under test
// (readDailyAndWeeklyMetricCandles's own dailyFrom/weeklyFrom filters) and,
// critically, so the LAST row lands in the current, still-forming week -
// exactly what's needed to exercise excludeIncompleteTradingWeek for real
// when the real deriveWeeklyMetricCandlesFromDaily aggregation runs on them.
function buildDailyRows(symbol: string, count: number, startClose = 100): FakeCandle[] {
  const today = new Date();
  return Array.from({ length: count }, (_, i) => {
    const daysAgo = count - 1 - i;
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return {
      symbol,
      time: date.toISOString().slice(0, 10),
      open: startClose + i,
      high: startClose + i + 1,
      low: startClose + i - 1,
      close: startClose + i,
      volume: 1000,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  safeProviderAction.mockImplementation(async (_action: string, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch {
      return null;
    }
  });
  backfillDailyCandles.mockResolvedValue({ insertedDaily: 1, insertedWeekly: 1, insertedMonthly: 1 } as never);
});

describe("readDailyAndWeeklyMetricCandles", () => {
  it("empty candle input with no legacy weekly candles triggers the seed-backfill fallback", async () => {
    readMetricCandles
      .mockResolvedValueOnce([]) // initial daily read
      .mockResolvedValueOnce([]) // legacy weekly read
      .mockResolvedValueOnce([]); // re-read after seed backfill

    const result = await readDailyAndWeeklyMetricCandles({
      exchange: "NSE",
      symbols: ["EMPTYSYM"],
      dailyFrom: "2024-01-01",
      weeklyFrom: "2024-01-01",
    });

    expect(safeProviderAction).toHaveBeenCalledWith(
      "market-data.relative-strength-seed-backfill",
      expect.any(Function)
    );
    expect(backfillDailyCandles).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "EMPTYSYM", exchange: "NSE" })
    );
    expect(result).toEqual({ dailyCandles: [], weeklyCandles: [] });
  });

  it("empty daily candles but present legacy weekly candles returns the legacy weekly series directly, without seed backfill", async () => {
    const legacyWeekly = buildDailyRows("LEGACY", 5);
    readMetricCandles
      .mockResolvedValueOnce([]) // initial daily read
      .mockResolvedValueOnce(legacyWeekly); // legacy weekly read

    const result = await readDailyAndWeeklyMetricCandles({
      exchange: "NSE",
      symbols: ["LEGACY"],
      dailyFrom: "2024-01-01",
      weeklyFrom: "2024-01-01",
    });

    expect(safeProviderAction).not.toHaveBeenCalled();
    expect(result.weeklyCandles).toEqual(legacyWeekly);
  });

  it("non-empty daily candles for multiple symbols are grouped and derived without any backfill", async () => {
    const rows = [...buildDailyRows("AAA", 10), ...buildDailyRows("BBB", 10)];
    readMetricCandles.mockResolvedValueOnce(rows);

    const result = await readDailyAndWeeklyMetricCandles({
      exchange: "NSE",
      symbols: ["AAA", "BBB"],
      dailyFrom: "2020-01-01",
      weeklyFrom: "2020-01-01",
    });

    expect(safeProviderAction).not.toHaveBeenCalled();
    expect(result.dailyCandles.length).toBe(20);
    // Real deriveWeeklyMetricCandlesFromDaily ran - weekly output exists
    // and is grouped per symbol (proves the real candles.ts helper was
    // actually invoked, not stubbed).
    expect(result.weeklyCandles.some((row) => row.symbol === "AAA")).toBe(true);
    expect(result.weeklyCandles.some((row) => row.symbol === "BBB")).toBe(true);
  });
});

describe("computeAllRelativeStrengthMetrics orchestration", () => {
  it("returns an empty array for an empty instrument pool without reading any candles", async () => {
    const result = await computeAllRelativeStrengthMetrics([], "NSE");
    expect(result).toEqual([]);
    expect(readMetricCandles).not.toHaveBeenCalled();
  });

  it("produces one output row per symbol with sufficient history, in the documented shape", async () => {
    const rows = buildDailyRows("TCS", 100);
    readMetricCandles.mockResolvedValueOnce(rows);

    const instruments: RelativeStrengthInstrumentInput[] = [
      { symbol: "TCS", name: "Tata Consultancy", exchange: "NSE", sector: "IT", industry: "Software" },
    ];

    const result = await computeAllRelativeStrengthMetrics(instruments, "NSE");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      symbol: "TCS",
      name: "Tata Consultancy",
      exchange: "NSE",
      sector: "IT",
      industry: "Software",
    });
    expect(typeof result[0].change55dPct).toBe("number");
  });

  it("excludes a symbol with insufficient daily history (<=54 bars) from the output", async () => {
    const rows = buildDailyRows("THINHIST", 10);
    readMetricCandles.mockResolvedValueOnce(rows);

    const instruments: RelativeStrengthInstrumentInput[] = [
      { symbol: "THINHIST", name: "Thin History Co", exchange: "NSE" },
    ];

    const result = await computeAllRelativeStrengthMetrics(instruments, "NSE");
    expect(result).toEqual([]);
  });
});

describe("computeWeeklyStrongStocks orchestration", () => {
  it("delegates the pass/fail decision to the canonical evaluateWeeklyStrongLatest, not a reimplementation", async () => {
    // Only one readMetricCandles call happens here: dailyFrom === weeklyFrom
    // for computeWeeklyStrongStocks, so readDailyAndWeeklyMetricCandles
    // fetches daily once and derives weekly from it via the real
    // deriveWeeklyMetricCandlesFromDaily aggregation - not a second fetch.
    const dailyRows = buildDailyRows("PASSSYM", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: true } as never);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "PASSSYM", name: "Pass Co", exchange: "NSE" }],
      "NSE"
    );

    expect(evaluateWeeklyStrongLatest).toHaveBeenCalledWith(
      dailyRows.map((r) => r.close),
      expect.any(Array)
    );
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("PASSSYM");
  });

  it("a symbol the evaluator rejects is excluded from the result", async () => {
    const dailyRows = buildDailyRows("FAILSYM", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: false } as never);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "FAILSYM", name: "Fail Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toEqual([]);
  });

  it("a symbol with insufficient history is excluded before the evaluator is ever called", async () => {
    readMetricCandles.mockResolvedValue([]);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "NODATA", name: "No Data Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toEqual([]);
    expect(evaluateWeeklyStrongLatest).not.toHaveBeenCalled();
  });
});

describe("deriveSectorIndustryTaxonomy", () => {
  function buildMetricRow(
    symbol: string,
    sector: string,
    industry: string
  ): RelativeStrengthMetricRow {
    return {
      symbol,
      name: symbol,
      exchange: "NSE",
      sector,
      industry,
      close: 100,
      volume: 1000,
      change55dPct: 0,
    };
  }

  it("resolves a sector/industry pair that only appears after index 500 in a >500-row pool, without losing or duplicating any other entry", () => {
    // 500 rows split across two sector/industry pairs (each repeated 250x,
    // proving de-duplication), then one more row past index 500 introducing
    // a brand-new pair that a ranked/limited top-N sample would have missed.
    const rows: RelativeStrengthMetricRow[] = [];
    for (let i = 0; i < 500; i++) {
      const isA = i % 2 === 0;
      rows.push(buildMetricRow(`SYM${i}`, isA ? "Sector A" : "Sector B", isA ? "Industry A1" : "Industry B1"));
    }
    rows.push(buildMetricRow("LATESYM", "Late Sector", "Late Industry"));

    expect(rows.length).toBeGreaterThan(500);
    expect(rows.findIndex((row) => row.sector === "Late Sector")).toBe(500);

    const taxonomy = deriveSectorIndustryTaxonomy(rows);

    // The late-appearing sector/industry pair is present and resolvable.
    const lateEntry = taxonomy.find((row) => row.sector === "Late Sector");
    expect(lateEntry).toBeDefined();
    expect(lateEntry?.industries).toContain("Late Industry");

    // Nothing lost: exactly the three distinct sectors survive, none merged
    // or dropped because of array size.
    expect(taxonomy.map((row) => row.sector).sort()).toEqual(["Late Sector", "Sector A", "Sector B"]);

    // 250 duplicate rows per sector collapse to a single industry entry
    // each - duplicates are deduplicated, not repeated per occurrence.
    const sectorA = taxonomy.find((row) => row.sector === "Sector A");
    const sectorB = taxonomy.find((row) => row.sector === "Sector B");
    expect(sectorA?.industries).toEqual(["Industry A1"]);
    expect(sectorB?.industries).toEqual(["Industry B1"]);

    // No proprietary score/ranking field leaks into the taxonomy shape -
    // every entry is exactly {sector, industries}.
    for (const entry of taxonomy) {
      expect(Object.keys(entry).sort()).toEqual(["industries", "sector"]);
    }
  });

  it("excludes rows missing a sector or industry classification", () => {
    const rows: RelativeStrengthMetricRow[] = [
      buildMetricRow("CLASSIFIED", "Sector A", "Industry A1"),
      { ...buildMetricRow("NOSECTOR", "Sector A", "Industry A1"), sector: null },
      { ...buildMetricRow("NOINDUSTRY", "Sector A", "Industry A1"), industry: null },
    ];

    const taxonomy = deriveSectorIndustryTaxonomy(rows);

    expect(taxonomy).toEqual([{ sector: "Sector A", industries: ["Industry A1"] }]);
  });
});

describe("getSymbolWeeklyStrongSeriesInput", () => {
  it("returns null for a symbol with insufficient history", async () => {
    readMetricCandles.mockResolvedValue([]);

    const result = await getSymbolWeeklyStrongSeriesInput("NODATA", "NSE");
    expect(result).toBeNull();
  });

  it("trims an incomplete trailing week from the weekly series before returning it", async () => {
    // buildDailyRows' last row is always dated today, so the real
    // deriveWeeklyMetricCandlesFromDaily aggregation (run internally by
    // readDailyAndWeeklyMetricCandles) always produces a last weekly
    // candle for the current, still-forming week - exactly what
    // excludeIncompleteTradingWeek is supposed to trim.
    const dailyRows = buildDailyRows("TRIMSYM", 400);
    const untrimmedWeekly = deriveWeeklyMetricCandlesFromDaily(dailyRows, dailyRows[0].time);
    readMetricCandles.mockResolvedValueOnce(dailyRows);

    const result = await getSymbolWeeklyStrongSeriesInput("TRIMSYM", "NSE");

    expect(result).not.toBeNull();
    expect(result?.weeklyRows.length).toBe(untrimmedWeekly.length - 1);
  });
});
