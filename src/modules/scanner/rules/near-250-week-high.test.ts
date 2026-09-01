import { describe, expect, it } from "vitest";

import {
  deriveScannerLookbackBars,
  evaluateWeeklyStrongSeries,
} from "../../market-data/weekly-strong-evaluator";
import { calculateNear250WeekHighScan } from "./near-250-week-high";

// Daily bars run 1:5 against weekly bars (deriveScannerLookbackBars), so a
// weekly series of `weeks` entries needs `weeks * 5` daily entries covering
// the same span for the two-condition evaluator to have a full window.
function buildSeries(weeks: number, weeklyClose: (index: number) => number) {
  const weeklyCandles = Array.from({ length: weeks }, (_, index) => ({
    time: `w-${String(index).padStart(4, "0")}`,
    close: weeklyClose(index),
  }));
  const dailyCandles = Array.from({ length: weeks * 5 }, (_, index) => ({
    time: `d-${String(index).padStart(5, "0")}`,
    close: weeklyClose(Math.floor(index / 5)),
  }));
  return { dailyCandles, weeklyCandles };
}

describe("near-250-week-high scan (Scanner live path)", () => {
  it("matches when both the daily and weekly close are within 15% of their rolling highs", () => {
    // Every bar (daily and weekly alike) closes at 900 except one early
    // spike to 1000 - so the rolling high is 1000, and 900/1000 = 90% >=
    // the 85% threshold on both legs.
    const { dailyCandles, weeklyCandles } = buildSeries(250, (index) =>
      index === 10 ? 1000 : 900
    );

    const result = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, 250);

    expect(result?.matched).toBe(true);
    expect(result?.highlightTimes).toContain(weeklyCandles[weeklyCandles.length - 1].time);
  });

  it("does not match when the weekly leg alone would pass but the daily leg fails - proving the daily confirmation condition is actually enforced", () => {
    const weeks = 250;
    const weeklyCandles = Array.from({ length: weeks }, (_, index) => ({
      time: `w-${String(index).padStart(4, "0")}`,
      // Weekly: spikes to 1000 once, otherwise closes at 900 (90% of high - passes weekly alone).
      close: index === 10 ? 1000 : 900,
    }));
    // Daily: spikes to 1000 once, otherwise closes at 500 (50% of high - fails daily alone).
    const dailyCandles = Array.from({ length: weeks * 5 }, (_, index) => ({
      time: `d-${String(index).padStart(5, "0")}`,
      close: index === 50 ? 1000 : 500,
    }));

    const result = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, weeks);

    // A weekly-only rule (the previous implementation) would have called
    // this a match. The two-condition evaluator must not.
    expect(result?.matched).toBe(false);
  });

  it("does not match when both legs close well below their rolling highs", () => {
    const { dailyCandles, weeklyCandles } = buildSeries(250, (index) =>
      index === 10 ? 1000 : 500
    );

    const result = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, 250);

    expect(result?.matched).toBe(false);
  });

  it("returns null when there isn't even a 1x (50-week) lookback tier of weekly history available", () => {
    const { dailyCandles, weeklyCandles } = buildSeries(49, () => 900);

    const result = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, 250);

    expect(result).toBeNull();
  });

  it("falls back to a smaller lookback tier when the full requested window isn't available, matching the previously-existing UX", () => {
    const { dailyCandles, weeklyCandles } = buildSeries(150, (index) =>
      index === 10 ? 1000 : 900
    );

    const result = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, 250);

    expect(result?.metrics.lookbackWeeks).toBe(150);
    expect(result?.matched).toBe(true);
  });

  it("highlights every historical week that passed both conditions, not just the latest", () => {
    const weeks = 60;
    const weeklyCandles = Array.from({ length: weeks }, (_, index) => ({
      time: `w-${String(index).padStart(4, "0")}`,
      close: index === 5 ? 1000 : index % 2 === 0 ? 900 : 500,
    }));
    const dailyCandles = Array.from({ length: weeks * 5 }, (_, index) => ({
      time: `d-${String(index).padStart(5, "0")}`,
      close: index === 25 ? 1000 : 900,
    }));

    const result = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, 50);

    expect(result?.highlightTimes).toContain(weeklyCandles[0].time);
    expect(result?.highlightTimes).not.toContain(weeklyCandles[1].time);
    expect(result?.highlightTimes).toContain(weeklyCandles[weeklyCandles.length - 2].time);
    expect(result?.highlightTimes).not.toContain(weeklyCandles[weeklyCandles.length - 1].time);
  });
});

// Consistency regression: this Scanner rule and computeSymbolBreakoutBacktest
// (market-data.service.ts) now both delegate to evaluateWeeklyStrongSeries
// with the SAME deriveScannerLookbackBars window sizing - this proves the
// live-scan wrapper produces exactly the evaluator's own answer rather than
// any local reimplementation, which is the actual bug this closes (see
// docs/KNOWN_ISSUES.md). completed-week trimming itself is applied upstream
// by both consumers via the shared getSymbolWeeklyStrongSeriesInput ->
// excludeIncompleteTradingWeek (covered directly in
// weekly-strong-evaluator.test.ts), so it isn't re-tested here.
describe("live scan vs. canonical evaluator consistency", () => {
  it("agrees with a direct evaluateWeeklyStrongSeries call, bar for bar, for a representative passing series", () => {
    const { dailyCandles, weeklyCandles } = buildSeries(250, (index) =>
      index % 20 === 0 ? 1000 : 800
    );
    const lookbackWeeks = 250;

    const scan = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, lookbackWeeks);
    const { dailyLookbackBars, weeklyLookbackBars } = deriveScannerLookbackBars(lookbackWeeks);
    const direct = evaluateWeeklyStrongSeries(dailyCandles, weeklyCandles, {
      dailyLookbackBars,
      weeklyLookbackBars,
    });

    const expectedHighlightTimes = direct.filter((point) => point.passes).map((point) => point.time);
    expect(scan?.highlightTimes).toEqual(expectedHighlightTimes);
    expect(scan?.matched).toBe(direct[direct.length - 1].passes);
  });

  it("agrees with a direct evaluateWeeklyStrongSeries call for a representative failing series (daily leg fails)", () => {
    const weeks = 250;
    const weeklyCandles = Array.from({ length: weeks }, (_, index) => ({
      time: `w-${String(index).padStart(4, "0")}`,
      close: index === 100 ? 1000 : 900,
    }));
    const dailyCandles = Array.from({ length: weeks * 5 }, (_, index) => ({
      time: `d-${String(index).padStart(5, "0")}`,
      close: index === 500 ? 1000 : 400,
    }));
    const lookbackWeeks = 250;

    const scan = calculateNear250WeekHighScan(dailyCandles, weeklyCandles, lookbackWeeks);
    const { dailyLookbackBars, weeklyLookbackBars } = deriveScannerLookbackBars(lookbackWeeks);
    const direct = evaluateWeeklyStrongSeries(dailyCandles, weeklyCandles, {
      dailyLookbackBars,
      weeklyLookbackBars,
    });

    expect(scan?.matched).toBe(false);
    expect(scan?.matched).toBe(direct[direct.length - 1].passes);
  });
});
