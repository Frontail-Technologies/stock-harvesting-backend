import { describe, expect, it } from "vitest";

import {
  evaluateWeeklyStrongLatest,
  evaluateWeeklyStrongSeries,
  excludeIncompleteTradingWeek,
  hasSufficientWeeklyStrongHistory,
  MIN_WEEKLY_STRONG_DAILY_BARS,
  MIN_WEEKLY_STRONG_WEEKLY_BARS,
  passesNearHigh,
  rollingMax,
  WEEKLY_STRONG_DAILY_LOOKBACK_BARS,
  WEEKLY_STRONG_NEAR_HIGH_RATIO,
  WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS,
} from "./weekly-strong-evaluator";

// Proprietary threshold regression guard - these values must never drift
// silently during a refactor. If one of these ever needs to change, it
// should be a deliberate, visible edit to this test, not a side effect.
describe("Weekly Strong constants - unchanged by the Phase C1/C1.5 refactors", () => {
  it("keeps the exact proprietary window sizes, ratio, and history floors", () => {
    expect(WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS).toBe(250);
    expect(WEEKLY_STRONG_DAILY_LOOKBACK_BARS).toBe(1252);
    expect(WEEKLY_STRONG_NEAR_HIGH_RATIO).toBe(0.85);
    expect(MIN_WEEKLY_STRONG_DAILY_BARS).toBe(50);
    expect(MIN_WEEKLY_STRONG_WEEKLY_BARS).toBe(20);
  });
});

// Builds an ascending daily/weekly-time-shaped candle series: `count` bars,
// all closing at `baseClose` except the last one (`latestClose`) and,
// optionally, an earlier spike bar that sets the trailing high. Dates are
// deliberately simple sequential day-strings ("day-000".."day-NNN") - the
// evaluator only ever compares `time` strings for ordering/equality, never
// parses them as real dates, so this is a faithful stand-in for real
// daily/weekly candle `time` values without depending on a real calendar.
function buildSeries(
  count: number,
  baseClose: number,
  latestClose: number,
  options: { spikeIndex?: number; spikeClose?: number; startIndex?: number } = {}
) {
  const start = options.startIndex ?? 0;
  return Array.from({ length: count }, (_, index) => {
    const isLast = index === count - 1;
    const isSpike = options.spikeIndex === index;
    return {
      time: `day-${String(start + index).padStart(4, "0")}`,
      close: isSpike ? (options.spikeClose ?? baseClose) : isLast ? latestClose : baseClose,
    };
  });
}

describe("hasSufficientWeeklyStrongHistory", () => {
  it("requires at least the daily and weekly bar floors", () => {
    expect(hasSufficientWeeklyStrongHistory(MIN_WEEKLY_STRONG_DAILY_BARS, MIN_WEEKLY_STRONG_WEEKLY_BARS)).toBe(
      true
    );
    expect(
      hasSufficientWeeklyStrongHistory(MIN_WEEKLY_STRONG_DAILY_BARS - 1, MIN_WEEKLY_STRONG_WEEKLY_BARS)
    ).toBe(false);
    expect(
      hasSufficientWeeklyStrongHistory(MIN_WEEKLY_STRONG_DAILY_BARS, MIN_WEEKLY_STRONG_WEEKLY_BARS - 1)
    ).toBe(false);
  });
});

describe("passesNearHigh (single-timeframe predicate)", () => {
  it("passes when the close sits above the ratio of the trailing high", () => {
    const closes = [700, 1000, 700, 700, 900]; // trailing high (of all 5) = 1000, 900 > 850
    expect(passesNearHigh(closes, 4, 5, WEEKLY_STRONG_NEAR_HIGH_RATIO)).toBe(true);
  });

  it("fails when the close sits below the ratio of the trailing high", () => {
    const closes = [700, 1000, 700, 700, 849.99];
    expect(passesNearHigh(closes, 4, 5, WEEKLY_STRONG_NEAR_HIGH_RATIO)).toBe(false);
  });

  it("is a strict inequality - exactly at the threshold does not pass", () => {
    // Deliberately differs from Scanner's near-250-week-high.ts chart-highlight
    // rule, which uses >= and does match at exactly the threshold - these are
    // two intentionally different rules (see the Phase C1 audit report), not
    // duplicates that should agree at the boundary.
    const closes = [1000, 850]; // 850 is exactly 85% of 1000
    expect(passesNearHigh(closes, 1, 2, WEEKLY_STRONG_NEAR_HIGH_RATIO)).toBe(false);
  });

  it("an all-time-high bar always passes (the window includes itself)", () => {
    const closes = [700, 800, 900, 1000];
    expect(passesNearHigh(closes, 3, 4, WEEKLY_STRONG_NEAR_HIGH_RATIO)).toBe(true);
  });

  it("only looks at the trailing lookback window, not the full series", () => {
    // A much higher close far outside the lookback window must not affect
    // the decision for the latest bar.
    const closes = [5000, 700, 700, 700, 900];
    expect(passesNearHigh(closes, 4, 3, WEEKLY_STRONG_NEAR_HIGH_RATIO)).toBe(true);
  });
});

describe("rollingMax", () => {
  it("matches a naive windowed max at every index", () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const windowSize = 4;
    const result = rollingMax(values, windowSize);

    const naive = values.map((_, index) => {
      const start = Math.max(0, index - windowSize + 1);
      return Math.max(...values.slice(start, index + 1));
    });

    expect(result).toEqual(naive);
  });
});

describe("evaluateWeeklyStrongLatest (the live Weekly Strong list's decision)", () => {
  const dailyPass = buildSeries(MIN_WEEKLY_STRONG_DAILY_BARS, 700, 900);
  const dailyFail = buildSeries(MIN_WEEKLY_STRONG_DAILY_BARS, 700, 500);
  const weeklyPass = buildSeries(MIN_WEEKLY_STRONG_WEEKLY_BARS, 700, 900);
  const weeklyFail = buildSeries(MIN_WEEKLY_STRONG_WEEKLY_BARS, 700, 500);

  it("passes only when BOTH the daily and weekly legs pass", () => {
    const decision = evaluateWeeklyStrongLatest(
      dailyPass.map((row) => row.close),
      weeklyPass.map((row) => row.close),
      { dailyLookbackBars: MIN_WEEKLY_STRONG_DAILY_BARS, weeklyLookbackBars: MIN_WEEKLY_STRONG_WEEKLY_BARS }
    );
    expect(decision).toEqual({ passes: true, passesDaily: true, passesWeekly: true });
  });

  it("fails when only the daily leg fails", () => {
    const decision = evaluateWeeklyStrongLatest(
      dailyFail.map((row) => row.close),
      weeklyPass.map((row) => row.close),
      { dailyLookbackBars: MIN_WEEKLY_STRONG_DAILY_BARS, weeklyLookbackBars: MIN_WEEKLY_STRONG_WEEKLY_BARS }
    );
    expect(decision).toEqual({ passes: false, passesDaily: false, passesWeekly: true });
  });

  it("fails when only the weekly leg fails", () => {
    const decision = evaluateWeeklyStrongLatest(
      dailyPass.map((row) => row.close),
      weeklyFail.map((row) => row.close),
      { dailyLookbackBars: MIN_WEEKLY_STRONG_DAILY_BARS, weeklyLookbackBars: MIN_WEEKLY_STRONG_WEEKLY_BARS }
    );
    expect(decision).toEqual({ passes: false, passesDaily: true, passesWeekly: false });
  });

  it("fails when both legs fail", () => {
    const decision = evaluateWeeklyStrongLatest(
      dailyFail.map((row) => row.close),
      weeklyFail.map((row) => row.close),
      { dailyLookbackBars: MIN_WEEKLY_STRONG_DAILY_BARS, weeklyLookbackBars: MIN_WEEKLY_STRONG_WEEKLY_BARS }
    );
    expect(decision).toEqual({ passes: false, passesDaily: false, passesWeekly: false });
  });

  it("defaults to the real proprietary window sizes when none are passed", () => {
    const daily = buildSeries(WEEKLY_STRONG_DAILY_LOOKBACK_BARS, 700, 900);
    const weekly = buildSeries(WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS, 700, 900);
    const decision = evaluateWeeklyStrongLatest(
      daily.map((row) => row.close),
      weekly.map((row) => row.close)
    );
    expect(decision.passes).toBe(true);
  });
});

describe("evaluateWeeklyStrongSeries (the backtest chart / Scanner overlay's decision)", () => {
  it("evaluates every weekly bar independently over its own trailing window", () => {
    // windowSize=3, closes = [700, 700, 1000, 700, 900, 600]. Worked by hand:
    //   i=0 window=[700]                 max=700  -> 700 > 595  -> pass (trivially its own high)
    //   i=1 window=[700,700]             max=700  -> 700 > 595  -> pass
    //   i=2 window=[700,700,1000]        max=1000 -> 1000 > 850 -> pass (sets the high)
    //   i=3 window=[700,1000,700]        max=1000 -> 700 > 850  -> FAIL (still under the spike)
    //   i=4 window=[1000,700,900]        max=1000 -> 900 > 850  -> pass
    //   i=5 window=[700,900,600]         max=900  -> 600 > 765  -> FAIL (spike aged out, new high is 900)
    const dailyLookback = 10;
    const weeklyLookback = 3;
    const daily = buildSeries(60, 700, 700); // flat, plenty of daily bars across the same range
    const weekly = [
      { time: "day-0000", close: 700 },
      { time: "day-0010", close: 700 },
      { time: "day-0020", close: 1000 },
      { time: "day-0030", close: 700 },
      { time: "day-0040", close: 900 },
      { time: "day-0050", close: 600 },
    ];

    const points = evaluateWeeklyStrongSeries(daily, weekly, {
      dailyLookbackBars: dailyLookback,
      weeklyLookbackBars: weeklyLookback,
    });

    expect(points.map((point) => point.passesWeekly)).toEqual([true, true, true, false, true, false]);
  });

  it("skips weekly bars with no daily data yet, rather than treating them as failing", () => {
    const weekly = [
      { time: "day-0005", close: 900 },
      { time: "day-0010", close: 900 },
    ];
    // No daily candle exists before day-0008 - the first weekly bar (day-0005)
    // has nothing to align to and must be skipped entirely, not counted as
    // a fail.
    const daily = [
      { time: "day-0008", close: 900 },
      { time: "day-0010", close: 900 },
    ];

    const points = evaluateWeeklyStrongSeries(daily, weekly, {
      dailyLookbackBars: 5,
      weeklyLookbackBars: 5,
    });

    expect(points).toHaveLength(1);
    expect(points[0].time).toBe("day-0010");
  });

  it("its last point agrees exactly with evaluateWeeklyStrongLatest for the same data", () => {
    // Daily and weekly share the same time axis here so the alignment walk
    // lands on the true last daily bar for the last weekly bar - exactly
    // what readDailyAndWeeklyMetricCandles' real output guarantees (both
    // derived from the same underlying daily feed, so the latest weekly
    // bar always covers up through the latest daily bar). Different
    // lookback bar COUNTS per leg still apply independently.
    const daily = buildSeries(120, 700, 950, { spikeIndex: 40, spikeClose: 1000 });
    const weekly = daily;
    const options = { dailyLookbackBars: 60, weeklyLookbackBars: 30 };

    const seriesPoints = evaluateWeeklyStrongSeries(daily, weekly, options);
    const latestDecision = evaluateWeeklyStrongLatest(
      daily.map((row) => row.close),
      weekly.map((row) => row.close),
      options
    );
    const lastSeriesPoint = seriesPoints[seriesPoints.length - 1];

    expect(lastSeriesPoint.passes).toBe(latestDecision.passes);
    expect(lastSeriesPoint.passesDaily).toBe(latestDecision.passesDaily);
    expect(lastSeriesPoint.passesWeekly).toBe(latestDecision.passesWeekly);
  });
});

// These two functions power two different UI surfaces (the live
// WeeklyStrongStockTable and the WeeklyStrongBacktestChart/Scanner overlay)
// that must agree on "does this symbol pass, right now" - this is the
// consistency guarantee the Phase C1 brief calls for.
describe("cross-consumer consistency: live list vs backtest, same underlying data", () => {
  it("produce identical pass/fail for several symbol-shaped series, including boundary cases", () => {
    // daily/weekly share the same 80-bar time axis in every case (see the
    // "same time axis" note above) - only the close values differ per case.
    const cases = [
      { daily: buildSeries(80, 700, 900), weekly: buildSeries(80, 700, 900) }, // both pass
      { daily: buildSeries(80, 700, 500), weekly: buildSeries(80, 700, 900) }, // daily fails
      { daily: buildSeries(80, 700, 900), weekly: buildSeries(80, 700, 500) }, // weekly fails
      {
        // daily latest close sits exactly at 85% of an earlier spike high -> fails (strict >)
        daily: buildSeries(80, 700, 850, { spikeIndex: 40, spikeClose: 1000 }),
        weekly: buildSeries(80, 700, 900),
      },
    ];
    const options = { dailyLookbackBars: 80, weeklyLookbackBars: 40 };

    for (const testCase of cases) {
      const latest = evaluateWeeklyStrongLatest(
        testCase.daily.map((row) => row.close),
        testCase.weekly.map((row) => row.close),
        options
      );
      const seriesLast = evaluateWeeklyStrongSeries(testCase.daily, testCase.weekly, options).at(-1);

      expect(seriesLast?.passes).toBe(latest.passes);
    }
  });
});

// Week of Mon 2026-01-05 .. Sun 2026-01-11 - see trading-calendar.test.ts
// for the underlying isCompletedTradingWeek behavior this builds on.
describe("excludeIncompleteTradingWeek", () => {
  const weeklyRows = [
    { time: "2025-12-22", close: 100 },
    { time: "2025-12-29", close: 101 },
    { time: "2026-01-05", close: 102 }, // the week in question
  ];

  it("drops the trailing week while it's still in progress", () => {
    const at = new Date("2026-01-06T10:05:00Z"); // Tuesday of that week
    const result = excludeIncompleteTradingWeek(weeklyRows, "NSE", at);
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.time)).toEqual(["2025-12-22", "2025-12-29"]);
  });

  it("keeps the trailing week once it's actually complete", () => {
    const at = new Date("2026-01-12T10:05:00Z"); // Monday of the following week
    const result = excludeIncompleteTradingWeek(weeklyRows, "NSE", at);
    expect(result).toHaveLength(3);
    expect(result).toEqual(weeklyRows);
  });

  it("only ever drops the LAST entry, never an already-complete earlier week", () => {
    // Even mid-week, the two prior (definitely complete) weeks must survive
    // untouched - only the trailing in-progress one is trimmed.
    const at = new Date("2026-01-06T10:05:00Z");
    const result = excludeIncompleteTradingWeek(weeklyRows, "NSE", at);
    expect(result[0]).toEqual(weeklyRows[0]);
    expect(result[1]).toEqual(weeklyRows[1]);
  });

  it("is a no-op on an empty series", () => {
    expect(excludeIncompleteTradingWeek([], "NSE")).toEqual([]);
  });
});

describe("live list vs backtest: neither can surface an incomplete current week", () => {
  it("computeWeeklyStrongStocks-shaped evaluation only ever sees completed weeks", () => {
    // A trailing in-progress week (today's daily candle already synced,
    // but the week it belongs to hasn't ended) must never reach
    // evaluateWeeklyStrongLatest - excludeIncompleteTradingWeek is what
    // every real call site (computeWeeklyStrongStocks,
    // computeWeeklyStrongStocksBacktest, computeSymbolBreakoutBacktest)
    // applies before evaluating, exactly like this.
    const weeklyRowsWithPartialWeek = [
      ...buildSeries(30, 700, 700),
      { time: "2026-01-05", close: 5000 }, // huge spike, but an in-progress week
    ];
    const at = new Date("2026-01-06T10:05:00Z"); // still mid-week

    const trimmed = excludeIncompleteTradingWeek(weeklyRowsWithPartialWeek, "NSE", at);

    expect(trimmed).toHaveLength(30);
    expect(trimmed.some((row) => row.time === "2026-01-05")).toBe(false);
  });
});
