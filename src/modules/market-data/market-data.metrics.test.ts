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

vi.mock("./market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn(),
}));

vi.mock("./weekly-strong-evaluator", async () => {
  const actual = await vi.importActual<typeof import("./weekly-strong-evaluator")>("./weekly-strong-evaluator");
  return { ...actual, evaluateWeeklyStrongSeries: vi.fn() };
});

import * as candlesModule from "./market-data.candles";
import { deriveWeeklyMetricCandlesFromDaily } from "./market-data.candles";
import * as candleSyncModule from "./market-data.candle-sync";
import * as instrumentsModule from "./market-data.instruments";
import { getWeekEndingFriday } from "./trading-calendar";
import * as evaluatorModule from "./weekly-strong-evaluator";
import {
  computeAllRelativeStrengthMetrics,
  computeWeeklyStrongBacktestMembers,
  computeWeeklyStrongStocks,
  deriveSectorIndustryTaxonomy,
  readDailyAndWeeklyMetricCandles,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
} from "./market-data.metrics";

const readMetricCandles = vi.mocked(candlesModule.readMetricCandles);
const safeProviderAction = vi.mocked(candleSyncModule.safeProviderAction);
const backfillDailyCandles = vi.mocked(candleSyncModule.backfillDailyCandles);
const getInstrumentsBySymbol = vi.mocked(instrumentsModule.getInstrumentsBySymbol);
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
  getInstrumentsBySymbol.mockImplementation(async (symbols) =>
    new Map(symbols.map((symbol) => [symbol, { id: `id-${symbol}` } as never]))
  );
});

describe("readDailyAndWeeklyMetricCandles", () => {
  it("empty candle input with no legacy weekly candles returns empty series without any provider call", async () => {
    readMetricCandles
      .mockResolvedValueOnce([]) // initial daily read
      .mockResolvedValueOnce([]); // legacy weekly read

    const result = await readDailyAndWeeklyMetricCandles({
      exchange: "NSE",
      instruments: [{ instrumentId: "EMPTYSYM", symbol: "EMPTYSYM" }],
      dailyFrom: "2024-01-01",
      weeklyFrom: "2024-01-01",
    });

    expect(safeProviderAction).not.toHaveBeenCalled();
    expect(backfillDailyCandles).not.toHaveBeenCalled();
    expect(result).toEqual({ dailyCandles: [], weeklyCandles: [] });
  });

  it("empty daily candles but present legacy weekly candles returns the legacy weekly series directly, without seed backfill", async () => {
    const legacyWeekly = buildDailyRows("LEGACY", 5);
    readMetricCandles
      .mockResolvedValueOnce([]) // initial daily read
      .mockResolvedValueOnce(legacyWeekly); // legacy weekly read

    const result = await readDailyAndWeeklyMetricCandles({
      exchange: "NSE",
      instruments: [{ instrumentId: "LEGACY", symbol: "LEGACY" }],
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
      instruments: [
        { instrumentId: "AAA", symbol: "AAA" },
        { instrumentId: "BBB", symbol: "BBB" },
      ],
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
      { instrumentId: "TCS", symbol: "TCS", name: "Tata Consultancy", exchange: "NSE", sector: "IT", industry: "Software" },
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
      { instrumentId: "THINHIST", symbol: "THINHIST", name: "Thin History Co", exchange: "NSE" },
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
    { instrumentId: "SENSEX", symbol: "SENSEX", name: "BSE SENSEX", exchange: "BSE_IDX" },
    { instrumentId: "BANKEX", symbol: "BANKEX", name: "BSE BANKEX", exchange: "BSE_IDX" },
  ];

  it("reads candles by instrument_id for the exact index instruments, not exchange/symbol", async () => {
    readMetricCandles.mockResolvedValue([]);

    await computeAllRelativeStrengthMetrics(bseIndexPool, "BSE_IDX");

    expect(readMetricCandles).toHaveBeenCalledWith(
      expect.objectContaining({
        instruments: [
          { instrumentId: "SENSEX", symbol: "SENSEX" },
          { instrumentId: "BANKEX", symbol: "BANKEX" },
        ],
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
      [{ instrumentId: "SENSEX", symbol: "SENSEX", name: "BSE SENSEX", exchange: "BSE_IDX" }],
      "BSE_IDX"
    );

    expect(result).toEqual([]);
  });

  it("returns a populated BSE_IDX metric once an index has >54 1D candles", async () => {
    readMetricCandles.mockResolvedValueOnce(buildDailyRows("SENSEX", 120));

    const result = await computeAllRelativeStrengthMetrics(
      [{ instrumentId: "SENSEX", symbol: "SENSEX", name: "BSE SENSEX", exchange: "BSE_IDX" }],
      "BSE_IDX"
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ symbol: "SENSEX", exchange: "BSE_IDX" });
    expect(typeof result[0].change55dPct).toBe("number");
  });
});

describe("computeWeeklyStrongStocks orchestration", () => {
  it("decides Harvest Results inclusion from the latest COMPLETED week's own series entry, not a separate live/latest-daily check", async () => {
    // Only one readMetricCandles call happens here: dailyFrom === weeklyFrom for computeWeeklyStrongStocks, so readDailyAndWeeklyMetricCandles fetches daily once and derives weekly via the real aggregation, not a second fetch.
    const dailyRows = buildDailyRows("PASSSYM", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "PASSSYM", symbol: "PASSSYM", name: "Pass Co", exchange: "NSE" }],
      "NSE"
    );

    expect(evaluateWeeklyStrongSeries).toHaveBeenCalledWith(dailyRows, expect.any(Array));
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("PASSSYM");
  });

  // Test 1 from the task: a fresher/incomplete daily state must never add a
  // stock to this completed-Friday dashboard when the latest COMPLETED
  // week's own series entry says false. There is no more separate "latest"
  // check to disagree with the series - the series is the only vote.
  it("1: excludes a symbol when the latest completed week's series entry fails, regardless of any fresher daily state", async () => {
    const dailyRows = buildDailyRows("FAILSYM", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-09-04", passes: false, passesDaily: false, passesWeekly: false },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "FAILSYM", symbol: "FAILSYM", name: "Fail Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toEqual([]);
  });

  // Test 2 from the task.
  it("2: includes a symbol when the latest completed week's series entry passes", async () => {
    const dailyRows = buildDailyRows("OKSYM", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "OKSYM", symbol: "OKSYM", name: "Ok Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toHaveLength(1);
  });

  it("a symbol with insufficient history is excluded before the evaluator is ever called", async () => {
    readMetricCandles.mockResolvedValue([]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "NODATA", symbol: "NODATA", name: "No Data Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toEqual([]);
    expect(evaluateWeeklyStrongSeries).not.toHaveBeenCalled();
  });

  it("an empty series (e.g. total data-alignment gap) excludes the symbol rather than throwing", async () => {
    const dailyRows = buildDailyRows("EMPTYSERIES", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "EMPTYSERIES", symbol: "EMPTYSERIES", name: "Empty Series Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toEqual([]);
  });

  it("Return uses the real current-streak-entry helper, not a reimplementation - entry close to today's close", async () => {
    const dailyRows = buildDailyRows("RETSYM", 400, 100);
    readMetricCandles.mockResolvedValueOnce(dailyRows);

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
      [{ instrumentId: "RETSYM", symbol: "RETSYM", name: "Return Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(((latestClose - entryRow.close) / entryRow.close) * 100);
    // D: inSince derives from the exact same entryIndex Return itself just used.
    expect(result[0].inSince).toBe(getWeekEndingFriday(entryRow.time));
  });

  // Test 5 from the task: a stock that reaches the result at all must always
  // have a valid (non-null) In Since - impossible to reach with a null entry
  // now that inclusion and inSince are decided from the exact same series.
  it("5: a Harvest Result stock always has a valid (non-null) In Since", async () => {
    const dailyRows = buildDailyRows("VALIDENTRY", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "VALIDENTRY", symbol: "VALIDENTRY", name: "Valid Entry Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result).toHaveLength(1);
    expect(result[0].inSince).not.toBeNull();
  });

  // Test 3 from the task.
  it("3: [F,F,T,T,T] -> In Since = first T's Friday", async () => {
    const dailyRows = buildDailyRows("STREAK4", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-07-31", passes: false, passesDaily: false, passesWeekly: false },
      { time: "2026-08-07", passes: false, passesDaily: false, passesWeekly: false },
      { time: "2026-08-14", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-21", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-28", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "STREAK4", symbol: "STREAK4", name: "Streak Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result[0].inSince).toBe("2026-08-14");
  });

  // Test 4 from the task.
  it("4: [T,T,F,T,T] -> In Since = second streak's first T's Friday", async () => {
    const dailyRows = buildDailyRows("REENTRY", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-14", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-21", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-28", passes: false, passesDaily: false, passesWeekly: false },
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-09-11", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "REENTRY", symbol: "REENTRY", name: "Re-entry Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result[0].inSince).toBe("2026-09-04");
  });

  it("E: a non-Friday entry-week candle date is converted to the canonical week-ending Friday, never returned raw", async () => {
    const dailyRows = buildDailyRows("RAWDATE", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    // 2026-08-10 is a Monday - its ISO week's Friday is 2026-08-14.
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-10", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "RAWDATE", symbol: "RAWDATE", name: "Raw Date Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result[0].inSince).toBe("2026-08-14");
  });

  it("F: a structurally missing week (not an explicit fail) breaks streak continuity - inSince never bridges the gap", async () => {
    const dailyRows = buildDailyRows("GAPSYM", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    // 2026-08-14 (Fri) then a two-week jump straight to 2026-08-28 (Fri) -
    // 2026-08-21's week is entirely absent from the series (e.g. a gap in
    // that symbol's candle history), not marked false. A naive pass/fail
    // walk would treat 08-14 and 08-28 as one unbroken streak; the real
    // current streak only starts at 08-28.
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-14", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-08-28", passes: true, passesDaily: true, passesWeekly: true },
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "GAPSYM", symbol: "GAPSYM", name: "Gap Co", exchange: "NSE" }],
      "NSE"
    );

    expect(result[0].inSince).toBe("2026-08-28");
  });

  it("G: the latest completed week is included in the streak walk (not off-by-one excluded)", async () => {
    const dailyRows = buildDailyRows("LATESTWK", 400);
    readMetricCandles.mockResolvedValueOnce(dailyRows);
    evaluateWeeklyStrongSeries.mockReturnValue([
      { time: "2026-08-28", passes: false, passesDaily: false, passesWeekly: false },
      { time: "2026-09-04", passes: true, passesDaily: true, passesWeekly: true },
    ]);

    const result = await computeWeeklyStrongStocks(
      [{ instrumentId: "LATESTWK", symbol: "LATESTWK", name: "Latest Week Co", exchange: "NSE" }],
      "NSE"
    );

    // The series' own last entry (the latest completed week) is the entry
    // week itself here, not excluded from consideration.
    expect(result[0].inSince).toBe("2026-09-04");
  });
});

// Tests 6-9 from the task: proves weekly analytical values are CLOSE, never
// HIGH, at the actual point MetricCandle (which carries a real .high field)
// feeds the evaluator - not just by the evaluator's own type signature
// (WeeklyStrongCandle/ScannerWeeklyCandle are already close-only, see
// weekly-strong-evaluator.ts/scanner-weekly-rule.ts), but end-to-end through
// computeWeeklyStrongStocks with the REAL (unmocked) evaluator.
describe("weekly analytical values use CLOSE, never HIGH (end-to-end, real evaluator)", () => {
  it("6/7: changing weekly HIGH alone, with CLOSE unchanged, does not change the Weekly Strong signal", async () => {
    const real = await vi.importActual<typeof import("./weekly-strong-evaluator")>("./weekly-strong-evaluator");
    evaluateWeeklyStrongSeries.mockImplementation(real.evaluateWeeklyStrongSeries);

    const baseline = buildDailyRows("HIGHTEST", 400);
    // Every bar's high is deliberately absurd relative to its own close - if
    // any weekly analytical path used high instead of close, this would
    // trivially always pass a near-high check regardless of the real close
    // trend, and the two runs below would disagree.
    const spikedHigh = baseline.map((row) => ({ ...row, high: row.close * 100 }));

    readMetricCandles.mockResolvedValueOnce(baseline);
    const baselineResult = await computeWeeklyStrongStocks(
      [{ instrumentId: "HIGHTEST", symbol: "HIGHTEST", name: "High Test Co", exchange: "NSE" }],
      "NSE"
    );

    readMetricCandles.mockResolvedValueOnce(spikedHigh);
    const spikedResult = await computeWeeklyStrongStocks(
      [{ instrumentId: "HIGHTEST", symbol: "HIGHTEST", name: "High Test Co", exchange: "NSE" }],
      "NSE"
    );

    expect(spikedResult.length).toBe(baselineResult.length);
    expect(spikedResult.length).toBeGreaterThan(0); // not a vacuous both-empty pass
    expect(spikedResult[0].inSince).toBe(baselineResult[0].inSince);
  });

  it("8: changing weekly CLOSE (high unchanged) can flip the signal - proves the HIGH test above isn't vacuous", async () => {
    const real = await vi.importActual<typeof import("./weekly-strong-evaluator")>("./weekly-strong-evaluator");
    evaluateWeeklyStrongSeries.mockImplementation(real.evaluateWeeklyStrongSeries);

    const rising = buildDailyRows("CLOSETEST", 400); // monotonically climbing close -> passes near-high
    readMetricCandles.mockResolvedValueOnce(rising);
    const risingResult = await computeWeeklyStrongStocks(
      [{ instrumentId: "CLOSETEST", symbol: "CLOSETEST", name: "Close Test Co", exchange: "NSE" }],
      "NSE"
    );
    expect(risingResult).toHaveLength(1); // sanity: baseline genuinely qualifies

    // Same series, but the trailing 10 bars' CLOSE collapses to a fraction of
    // the established high - high is untouched.
    const collapsedClose = rising.map((row, i) =>
      i >= rising.length - 10 ? { ...row, close: row.close * 0.1 } : row
    );
    readMetricCandles.mockResolvedValueOnce(collapsedClose);
    const collapsedResult = await computeWeeklyStrongStocks(
      [{ instrumentId: "CLOSETEST", symbol: "CLOSETEST", name: "Close Test Co", exchange: "NSE" }],
      "NSE"
    );

    expect(collapsedResult).toEqual([]); // close-driven collapse correctly excludes it
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
        { instrumentId: "MEMBERA", symbol: "MEMBERA", name: "Member A", exchange: "NSE" },
        { instrumentId: "MEMBERB", symbol: "MEMBERB", name: "Member B", exchange: "NSE" },
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
        { instrumentId: "MEMBERA", symbol: "MEMBERA", name: "Member A", exchange: "NSE" },
        { instrumentId: "MEMBERB", symbol: "MEMBERB", name: "Member B", exchange: "NSE" },
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
