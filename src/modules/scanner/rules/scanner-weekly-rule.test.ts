import { describe, expect, it } from "vitest";

import { evaluateScannerWeeklySeries, SCANNER_NEAR_HIGH_RATIO, type ScannerWeeklyCandle } from "./scanner-weekly-rule";

function buildWeeklySeries(count: number, close: (index: number) => number): ScannerWeeklyCandle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: `w-${String(index).padStart(4, "0")}`,
    close: close(index),
  }));
}

describe("evaluateScannerWeeklySeries", () => {
  it("uses exactly 0.85 as the near-high ratio", () => {
    expect(SCANNER_NEAR_HIGH_RATIO).toBe(0.85);
  });

  it("passes when the weekly close is above 0.85 of the rolling weekly-close high", () => {
    const weekly = buildWeeklySeries(5, (index) => (index === 0 ? 1000 : 900));

    const points = evaluateScannerWeeklySeries(weekly, 5);

    expect(points[points.length - 1].passes).toBe(true);
  });

  it("fails when the weekly close is below 0.85 of the rolling weekly-close high", () => {
    const weekly = buildWeeklySeries(5, (index) => (index === 0 ? 1000 : 500));

    const points = evaluateScannerWeeklySeries(weekly, 5);

    expect(points[points.length - 1].passes).toBe(false);
  });

  it("is a strict inequality - exactly at the threshold does not pass", () => {
    const weekly: ScannerWeeklyCandle[] = [
      { time: "w-0000", close: 1000 },
      { time: "w-0001", close: 850 }, // exactly 85% of 1000
    ];

    const points = evaluateScannerWeeklySeries(weekly, 2);

    expect(points[1].passes).toBe(false);
  });

  it("passes when strictly above the threshold", () => {
    const weekly: ScannerWeeklyCandle[] = [
      { time: "w-0000", close: 1000 },
      { time: "w-0001", close: 850.01 },
    ];

    const points = evaluateScannerWeeklySeries(weekly, 2);

    expect(points[1].passes).toBe(true);
  });

  it("includes the evaluated bar itself in the rolling window - an all-time-high always passes", () => {
    const weekly = buildWeeklySeries(4, (index) => 700 + index * 100);

    const points = evaluateScannerWeeklySeries(weekly, 4);

    expect(points[3].passes).toBe(true);
  });

  it("ages an old maximum out of the window once it falls outside lookbackWeeks", () => {
    const closes = [700, 700, 1000, 700, 900, 600];
    const weekly = buildWeeklySeries(closes.length, (index) => closes[index]);

    const points = evaluateScannerWeeklySeries(weekly, 3);

    // Indices 0-1 have fewer than 3 (lookbackWeeks) bars behind them, so they
    // can never pass regardless of their close/rolling-high ratio.
    expect(points.map((point) => point.passes)).toEqual([false, false, true, false, true, false]);
  });

  it("never produces a signal before a full lookbackWeeks window exists", () => {
    // Every close is a fresh all-time high, which would trivially "pass" at
    // every index under an inclusive-but-unbounded window - the full-window
    // requirement must still suppress indices 0..N-2.
    const weekly = buildWeeklySeries(10, (index) => 700 + index * 50);

    const points = evaluateScannerWeeklySeries(weekly, 5);

    expect(points.slice(0, 4).every((point) => !point.passes)).toBe(true);
    expect(points[4].passes).toBe(true);
  });

  it("returns one qualification point per input weekly candle, aligned by index", () => {
    const weekly = buildWeeklySeries(10, () => 900);

    const points = evaluateScannerWeeklySeries(weekly, 5);

    expect(points.map((point) => point.time)).toEqual(weekly.map((row) => row.time));
  });
});

describe("KOTAKBANK 2026-06-01 boundary regression (5x / 250-week)", () => {
  const LOOKBACK_WEEKS = 250;
  const PEAK_CLOSE = 443.95; // real observed 250-week high, week ending 2025-07-07
  const THRESHOLD = PEAK_CLOSE * SCANNER_NEAR_HIGH_RATIO; // 377.3575

  function buildKotakLikeSeries(targetClose: number): ScannerWeeklyCandle[] {
    const weeks: ScannerWeeklyCandle[] = [];
    for (let index = 0; index < 248; index++) {
      weeks.push({ time: `w-${String(index).padStart(4, "0")}`, close: index === 201 ? PEAK_CLOSE : 380 });
    }
    weeks.push({ time: "2026-05-25", close: 384.7 }); // index 248 - previous week
    weeks.push({ time: "2026-06-01", close: targetClose }); // index 249 - target, first index with a full 250-week window
    weeks.push({ time: "2026-06-08", close: 403.35 }); // index 250 - next week
    return weeks;
  }

  it("the real observed close (377.50) sits just above threshold - matches production's IN result, proving the formula itself is not the defect", () => {
    const points = evaluateScannerWeeklySeries(buildKotakLikeSeries(377.5), LOOKBACK_WEEKS);

    expect(points[249].passes).toBe(true);
  });

  it("a ~0.04% lower close (377.30, still a plausible candle-data variance) flips the same week to OUT", () => {
    const points = evaluateScannerWeeklySeries(buildKotakLikeSeries(377.3), LOOKBACK_WEEKS);

    expect(points[249].passes).toBe(false);
  });

  it("exactly at the 85% threshold is OUT - strict > is preserved at this real-world boundary", () => {
    const points = evaluateScannerWeeklySeries(buildKotakLikeSeries(THRESHOLD), LOOKBACK_WEEKS);

    expect(points[249].passes).toBe(false);
  });

  it("the previous week never passes - it does not yet have a full 250-week window, regardless of the target's own close", () => {
    const inCase = evaluateScannerWeeklySeries(buildKotakLikeSeries(377.5), LOOKBACK_WEEKS);
    const outCase = evaluateScannerWeeklySeries(buildKotakLikeSeries(377.3), LOOKBACK_WEEKS);

    expect(inCase[248].passes).toBe(false);
    expect(outCase[248].passes).toBe(false);
  });

  it("the next week retains its own correct state independent of the target's close", () => {
    const inCase = evaluateScannerWeeklySeries(buildKotakLikeSeries(377.5), LOOKBACK_WEEKS);
    const outCase = evaluateScannerWeeklySeries(buildKotakLikeSeries(377.3), LOOKBACK_WEEKS);

    expect(inCase[250].passes).toBe(true);
    expect(outCase[250].passes).toBe(true);
  });

  it("the target index is exactly where a full 250-week window first becomes available", () => {
    const series = buildKotakLikeSeries(377.5);
    expect(series.length).toBe(251); // indices 0..250: 249 valid weeks precede the target
    expect(series[249].time).toBe("2026-06-01");
  });
});
