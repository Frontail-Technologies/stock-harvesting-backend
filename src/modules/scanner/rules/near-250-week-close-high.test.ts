import { describe, expect, it } from "vitest";

import { calculateNear250WeekCloseHighScan } from "./near-250-week-close-high";
import { evaluateScannerWeeklySeries, type ScannerWeeklyCandle } from "./scanner-weekly-rule";

function buildWeeklySeries(weeks: number, weeklyClose: (index: number) => number, offset = 0): ScannerWeeklyCandle[] {
  return Array.from({ length: weeks }, (_, index) => ({
    time: `w-${String(index + offset).padStart(5, "0")}`,
    close: weeklyClose(index),
  }));
}

describe("near-250-week-close-high scan (Scanner live path) - single continuous segment", () => {
  it("matches when the weekly close is within 15% of its rolling weekly-close high", () => {
    const weeklyCandles = buildWeeklySeries(250, (index) => (index === 10 ? 1000 : 900));

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 250);

    expect(result?.matched).toBe(true);
    expect(result?.highlightTimes).toContain(weeklyCandles[weeklyCandles.length - 1].time);
  });

  it("does not depend on daily candles at all - the qualification rule takes only weekly closes", () => {
    const weeklyCandles = buildWeeklySeries(250, (index) => (index === 10 ? 1000 : 900));

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 250);

    expect(result?.matched).toBe(true);
  });

  it("does not match when the weekly close is well below its rolling weekly-close high", () => {
    const weeklyCandles = buildWeeklySeries(250, (index) => (index === 10 ? 1000 : 500));

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 250);

    expect(result?.matched).toBe(false);
  });

  it("returns null when there isn't even a 1x (50-week) lookback tier of weekly history available", () => {
    const weeklyCandles = buildWeeklySeries(49, () => 900);

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 250);

    expect(result).toBeNull();
  });

  it("falls back to a smaller lookback tier for the CURRENT verdict when the full requested window isn't available", () => {
    const weeklyCandles = buildWeeklySeries(150, (index) => (index === 10 ? 1000 : 900));

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 250);

    expect(result?.metrics.lookbackWeeks).toBe(150);
    expect(result?.matched).toBe(true);
  });

  it("uses the effective fallback tier for highlightTimes when the requested window is longer than the segment", () => {
    const weeklyCandles = buildWeeklySeries(150, (index) => (index === 10 ? 1000 : 900));

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 250);

    expect(result?.metrics.lookbackWeeks).toBe(150);
    expect(result?.matched).toBe(true);
    expect(result?.highlightTimes).toContain(weeklyCandles[weeklyCandles.length - 1].time);
  });

  it("highlights multiple historical weeks, never before a full lookbackWeeks window exists", () => {
    const weeks = 60;
    // Rising close, so every index at or after the 50-week warm-up point is
    // trivially its own trailing high.
    const weeklyCandles = buildWeeklySeries(weeks, (index) => 500 + index);

    const result = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, 50);

    expect(result?.highlightTimes).not.toContain(weeklyCandles[0].time);
    expect(result?.highlightTimes).not.toContain(weeklyCandles[48].time);
    expect(result?.highlightTimes).toContain(weeklyCandles[49].time);
    expect(result?.highlightTimes).toContain(weeklyCandles[59].time);
    expect(result?.highlightTimes?.length).toBe(11); // indices 49..59
  });

  it("agrees with a direct evaluateScannerWeeklySeries call, bar for bar", () => {
    const weeklyCandles = buildWeeklySeries(250, (index) => (index % 20 === 0 ? 1000 : 800));
    const lookbackWeeks = 250;

    const scan = calculateNear250WeekCloseHighScan([weeklyCandles], weeklyCandles, true, lookbackWeeks);
    const direct = evaluateScannerWeeklySeries(weeklyCandles, lookbackWeeks);

    const expectedHighlightTimes = direct.filter((point) => point.passes).map((point) => point.time);
    expect(scan?.highlightTimes).toEqual(expectedHighlightTimes);
    expect(scan?.matched).toBe(direct[direct.length - 1].passes);
  });
});

describe("current qualification unavailable does not erase historical highlightTimes", () => {
  it("returns historical matches even when isLatestWeekFresh is false", () => {
    const historical = buildWeeklySeries(60, (index) => 500 + index);

    const result = calculateNear250WeekCloseHighScan([historical], historical, false, 50);

    expect(result).not.toBeNull();
    expect(result?.matched).toBeUndefined();
    expect(result?.highlightTimes.length).toBeGreaterThan(0);
  });

  it("leaves the current verdict undefined (not a false match) when the latest segment is too short for any effective tier", () => {
    const historical = buildWeeklySeries(60, (index) => 500 + index);
    const shortLatest = buildWeeklySeries(10, () => 100, 1000);

    const result = calculateNear250WeekCloseHighScan([historical, shortLatest], shortLatest, true, 50);

    expect(result?.matched).toBeUndefined();
    expect(result?.highlightTimes.length).toBeGreaterThan(0);
  });
});

describe("REQUIRED REGRESSION - TCS/LALPATHLAB class (historical bands survive a trailing gap)", () => {
  it("200+ valid weeks with known historical matches, gap, <50 valid weeks after, latest invalid: historical remains, current unavailable", () => {
    const olderSegment = buildWeeklySeries(220, (index) => 500 + index); // monotonically rising -> passes from index 49 onward
    const recentShortSegment = buildWeeklySeries(20, () => 100, 1000); // far short of the 50-week floor

    const result = calculateNear250WeekCloseHighScan(
      [olderSegment, recentShortSegment],
      recentShortSegment,
      false, // latest completed week is invalid/partial - not fresh
      50
    );

    expect(result).not.toBeNull();
    // Historical matches before the gap remain present.
    expect(result?.highlightTimes.length).toBe(220 - 49); // indices 49..219 of olderSegment
    expect(result?.highlightTimes).toContain(olderSegment[219].time);
    // No highlight originates from the short recent segment - it never
    // reaches a full 50-week window.
    for (const row of recentShortSegment) {
      expect(result?.highlightTimes).not.toContain(row.time);
    }
    // Current/latest qualification is unavailable, not a fabricated match.
    expect(result?.matched).toBeUndefined();
    expect(result?.metrics.lookbackWeeks).toBeNull();
  });
});
