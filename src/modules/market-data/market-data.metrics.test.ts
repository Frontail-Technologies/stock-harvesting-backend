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
  return { ...actual, evaluateWeeklyStrongLatest: vi.fn(), evaluateWeeklyStrongSeries: vi.fn() };
});

import * as candlesModule from "./market-data.candles";
import { deriveWeeklyMetricCandlesFromDaily } from "./market-data.candles";
import * as candleSyncModule from "./market-data.candle-sync";
import { getWeekEndingFriday } from "./trading-calendar";
import * as evaluatorModule from "./weekly-strong-evaluator";
import {
  computeAllRelativeStrengthMetrics,
  computeWeeklyStrongBacktestMembers,
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
const evaluateWeeklyStrongSeries = vi.mocked(evaluatorModule.evaluateWeeklyStrongSeries);

type FakeCandle = { symbol: string; time: string; open: number; high: number; low: number; close: number; volume: number };

// Generates `count` consecutive daily rows ending TODAY (oldest first) so they fall inside every lookback window under test and, critically, the LAST row lands in the current still-forming week - what's needed to exercise excludeIncompleteTradingWeek for real.
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
  // Safe default for tests that don't care about Return specifically - an empty series means findCurrentStreakEntryIndex returns null, so returnPct comes out null rather than crashing on an unconfigured mock.
  evaluateWeeklyStrongSeries.mockReturnValue([]);
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
    // Real deriveWeeklyMetricCandlesFromDaily ran - weekly output exists and is grouped per symbol (proves the real candles.ts helper was invoked, not stubbed).
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

// Dashboard "Index Harvest" (useIndexRelativeStrength(150, "BSE_IDX")) runs
// through this exact function with exchange "BSE_IDX". These lock in the
// identity + the candle-eligibility gate that made production return
// `{"metrics":[],"asOfDate":...}` when BSE index history had never been
// backfilled (instruments present, but every symbol had <=54 1D candles).
describe("computeAllRelativeStrengthMetrics - BSE_IDX (Index Harvest read path)", () => {
  const bseIndexPool: RelativeStrengthInstrumentInput[] = [
    { symbol: "SENSEX", name: "BSE SENSEX", exchange: "BSE_IDX" },
    { symbol: "BANKEX", name: "BSE BANKEX", exchange: "BSE_IDX" },
  ];

  it("reads candles for exchange BSE_IDX with the exact index symbols", async () => {
    readMetricCandles.mockResolvedValue([]);

    await computeAllRelativeStrengthMetrics(bseIndexPool, "BSE_IDX");

    expect(readMetricCandles).toHaveBeenCalledWith(
      expect.objectContaining({
        exchange: "BSE_IDX",
        symbols: ["SENSEX", "BANKEX"],
        timeframe: "1D",
      })
    );
  });

  it("returns empty metrics when BSE_IDX instruments exist but have no 1D candles (the production symptom)", async () => {
    // initial daily read, legacy weekly read, re-read after seed backfill
    readMetricCandles
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await computeAllRelativeStrengthMetrics(bseIndexPool, "BSE_IDX");

    expect(result).toEqual([]);
  });

  it("still returns empty metrics when a BSE index has candles but <=54 of them", async () => {
    readMetricCandles.mockResolvedValueOnce(buildDailyRows("SENSEX", 40));

    const result = await computeAllRelativeStrengthMetrics(
      [{ symbol: "SENSEX", name: "BSE SENSEX", exchange: "BSE_IDX" }],
      "BSE_IDX"
    );

    expect(result).toEqual([]);
  });

  it("returns a populated BSE_IDX metric once an index has >54 1D candles", async () => {
    readMetricCandles.mockResolvedValueOnce(buildDailyRows("SENSEX", 120));

    const result = await computeAllRelativeStrengthMetrics(
      [{ symbol: "SENSEX", name: "BSE SENSEX", exchange: "BSE_IDX" }],
      "BSE_IDX"
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ symbol: "SENSEX", exchange: "BSE_IDX" });
    expect(typeof result[0].change55dPct).toBe("number");
  });
});

describe("computeWeeklyStrongStocks orchestration", () => {
  it("delegates the pass/fail decision to the canonical evaluateWeeklyStrongLatest, not a reimplementation", async () => {
    // Only one readMetricCandles call happens here: dailyFrom === weeklyFrom for computeWeeklyStrongStocks, so readDailyAndWeeklyMetricCandles fetches daily once and derives weekly via the real aggregation, not a second fetch.
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

  it("Return uses the real current-streak-entry helper, not a reimplementation - entry close to today's close", async () => {
    const dailyRows = buildDailyRows("RETSYM", 400, 100);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: true } as never);

    // Mirrors computeWeeklyStrongStocks' real (unmocked) weekly derivation plus its incomplete-trailing-week trim, so this fixture's `time` values line up with the weekly rows the function under test actually works with.
    const weeklyRows = deriveWeeklyMetricCandlesFromDaily(dailyRows, "2000-01-01").slice(0, -1);
    const entryRow = weeklyRows[weeklyRows.length - 4];
    const latestClose = dailyRows[dailyRows.length - 1].close;

    evaluateWeeklyStrongSeries.mockReturnValue(
      weeklyRows.slice(-4).map((row) => ({
        time: row.time,
        passes: row.time >= entryRow.time,
        passesDaily: row.time >= entryRow.time,
        passesWeekly: row.time >= entryRow.time,
      }))
    );

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "RETSYM", name: "Return Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(((latestClose - entryRow.close) / entryRow.close) * 100);
    // D: inSince derives from the exact same entryIndex Return itself just used.
    expect(result[0].inSince).toBe(getWeekEndingFriday(entryRow.time));
  });

  it("Return is null (not 0%) when the series has no currently-open qualifying streak, and inSince is null too", async () => {
    const dailyRows = buildDailyRows("NOENTRY", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: true } as never);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2024-01-05", passes: false, passesDaily: false, passesWeekly: false },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "NOENTRY", name: "No Entry Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeNull();
    expect(result[0].inSince).toBeNull();
  });

  it("A: an uninterrupted 4-week streak reports inSince as the first (oldest) week of that streak", async () => {
    const dailyRows = buildDailyRows("STREAK4", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: true } as never);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-14", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-21", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-28", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "STREAK4", name: "Streak Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result[0].inSince).toBe("2026-08-14");
  });

  it("B/C: a broken streak (drop out then re-enter) resets inSince to the latest re-entry week only", async () => {
    const dailyRows = buildDailyRows("REENTRY", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: true } as never);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-14", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-21", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-28", passes: false, passesDaily: false, passesWeekly: false },
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "REENTRY", name: "Re-entry Co", exchange: "NSE" }],
      "NSE"
    );

    // C: a fresh one-week streak reports inSince as that same current week, not the earlier pre-break streak.
    expect(result[0].inSince).toBe("2026-09-04");
  });

  it("E: a non-Friday entry-week candle date is converted to the canonical week-ending Friday, never returned raw", async () => {
    const dailyRows = buildDailyRows("RAWDATE", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongLatest.mockReturnValue({ passes: true } as never);
    // 2026-08-10 is a Monday - its ISO week's Friday is 2026-08-14.
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-10", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ symbol: "RAWDATE", name: "Raw Date Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result[0].inSince).toBe("2026-08-14");
  });
});

describe("computeWeeklyStrongBacktestMembers: cross-instrument week grouping", () => {
  // Regression for a real bug hit against a live collection: two members' own weekly candles
  // landed on different raw days for the same calendar week (ragged per-instrument daily
  // coverage), and the union of raw point.time values split one week into two persisted rows.
  it("merges two members whose evaluator series report different raw dates for the same ISO week into one week", async () => {
    const dailyA = buildDailyRows("MEMBERA", 400);
    const dailyB = buildDailyRows("MEMBERB", 400);
    readMetricCandles.mockResolvedValueOnce([...dailyA, ...dailyB]);

    evaluateWeeklyStrongSeries
      .mockReturnValueOnce([{ time: "2025-02-03", passes: true }] as never)
      .mockReturnValueOnce([{ time: "2025-02-04", passes: true }] as never);

    const result = await computeWeeklyStrongBacktestMembers(
      [
        { symbol: "MEMBERA", name: "Member A", exchange: "NSE" },
        { symbol: "MEMBERB", name: "Member B", exchange: "NSE" },
      ],
      "NSE",
      10
    );

    expect(result).toHaveLength(1);
    expect(result[0].time).toBe("2025-02-07");
    expect(result[0].passing.map((row) => row.symbol).sort()).toEqual(["MEMBERA", "MEMBERB"]);
  });

  it("keeps two members' points as separate weeks when their raw dates genuinely fall in different ISO weeks", async () => {
    const dailyA = buildDailyRows("MEMBERA", 400);
    const dailyB = buildDailyRows("MEMBERB", 400);
    readMetricCandles.mockResolvedValueOnce([...dailyA, ...dailyB]);

    evaluateWeeklyStrongSeries
      .mockReturnValueOnce([{ time: "2025-02-04", passes: true }] as never)
      .mockReturnValueOnce([{ time: "2025-02-11", passes: true }] as never);

    const result = await computeWeeklyStrongBacktestMembers(
      [
        { symbol: "MEMBERA", name: "Member A", exchange: "NSE" },
        { symbol: "MEMBERB", name: "Member B", exchange: "NSE" },
      ],
      "NSE",
      10
    );

    expect(result.map((point) => point.time)).toEqual(["2025-02-07", "2025-02-14"]);
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
    // 500 rows split across two sector/industry pairs (each repeated 250x, proving de-duplication), plus one more row past index 500 with a brand-new pair a ranked/limited top-N sample would have missed.
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

    // Nothing lost: exactly the three distinct sectors survive, none merged or dropped because of array size.
    expect(taxonomy.map((row) => row.sector).sort()).toEqual(["Late Sector", "Sector A", "Sector B"]);

    // 250 duplicate rows per sector collapse to a single industry entry each - duplicates are deduplicated, not repeated per occurrence.
    const sectorA = taxonomy.find((row) => row.sector === "Sector A");
    const sectorB = taxonomy.find((row) => row.sector === "Sector B");
    expect(sectorA?.industries).toEqual(["Industry A1"]);
    expect(sectorB?.industries).toEqual(["Industry B1"]);

    // No proprietary score/ranking field leaks into the taxonomy shape - every entry is exactly {sector, industries}.
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
    // buildDailyRows' last row is always dated today, so the real weekly aggregation (run internally by readDailyAndWeeklyMetricCandles) always produces a last weekly candle for the current, still-forming week - what excludeIncompleteTradingWeek is supposed to trim.
    const dailyRows = buildDailyRows("TRIMSYM", 400);
    const untrimmedWeekly = deriveWeeklyMetricCandlesFromDaily(dailyRows, dailyRows[0].time);
    readMetricCandles.mockResolvedValueOnce(dailyRows);

    const result = await getSymbolWeeklyStrongSeriesInput("TRIMSYM", "NSE");

    expect(result).not.toBeNull();
    expect(result?.weeklyRows.length).toBe(untrimmedWeekly.length - 1);
  });
});
