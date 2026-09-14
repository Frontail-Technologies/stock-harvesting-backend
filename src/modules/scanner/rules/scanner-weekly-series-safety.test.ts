import { describe, expect, it } from "vitest";

import { classifyScannerWeeklySeries } from "./scanner-weekly-series-safety";

function weekly(times: string[]) {
  return times.map((time) => ({ time, close: 100 }));
}

describe("classifyScannerWeeklySeries", () => {
  it("keeps the full series as one segment when every completed week is exactly 7 days apart", () => {
    const weeklyCandles = weekly(["2026-01-02", "2026-01-09", "2026-01-16"]);
    const at = new Date("2026-01-20T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.segments).toEqual([weeklyCandles]);
    expect(result.latestSegment).toEqual(weeklyCandles);
  });

  it("a completed week derived from a single actual daily session stays in the same segment - continuity is not broken", () => {
    const weeklyCandles = weekly(["2026-01-02", "2026-01-09", "2026-01-16"]);
    const at = new Date("2026-01-20T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.segments).toEqual([weeklyCandles]);
    expect(result.latestSegment).toEqual(weeklyCandles);
    expect(result.isLatestWeekFresh).toBe(true);
  });

  it("a fully missing completed week (no weekly candle at all) is the only continuity boundary - splits into two segments", () => {
    const weeklyCandles = weekly(["2026-01-02", "2026-01-16"]); // 2026-01-09 entirely absent
    const at = new Date("2026-01-20T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.segments).toEqual([weekly(["2026-01-02"]), weekly(["2026-01-16"])]);
    expect(result.latestSegment).toEqual(weekly(["2026-01-16"]));
  });

  it("a younger stock with genuinely short but continuous history keeps its entire series as one segment", () => {
    const weeklyCandles = weekly(["2026-01-02", "2026-01-09"]);
    const at = new Date("2026-01-13T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.segments).toEqual([weeklyCandles]);
  });

  it("is fresh when the latest week is a normal, complete week", () => {
    const weeklyCandles = weekly(["2026-01-02"]);
    const at = new Date("2026-01-06T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.isLatestWeekFresh).toBe(true);
  });

  it("is fresh even when the latest week has only one actual daily session - session count does not gate freshness", () => {
    const weeklyCandles = weekly(["2026-01-02"]);
    const at = new Date("2026-01-06T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.isLatestWeekFresh).toBe(true);
    expect(result.latestSegment).toEqual(weeklyCandles);
  });

  it("is stale when the latest expected completed week is entirely missing (zero daily candles)", () => {
    const weeklyCandles = weekly(["2025-12-19"]);
    const at = new Date("2026-01-06T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.isLatestWeekFresh).toBe(false);
  });

  it("a stale/missing latest week does not erase an earlier valid segment", () => {
    const weeklyCandles = weekly(["2025-12-19"]);
    const at = new Date("2026-01-06T10:00:00Z");

    const result = classifyScannerWeeklySeries(weeklyCandles, "NSE", at);

    expect(result.segments).toEqual([weekly(["2025-12-19"])]);
  });

  it("is never fresh for an empty series and produces no segments", () => {
    const result = classifyScannerWeeklySeries([], "NSE");
    expect(result.isLatestWeekFresh).toBe(false);
    expect(result.segments).toEqual([]);
    expect(result.latestSegment).toEqual([]);
  });
});
