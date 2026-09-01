import { describe, expect, it } from "vitest";

import {
  CHANGE_55D_LOOKBACK_BARS,
  calculate55DayChange,
  type MetricCandle,
} from "./market-data.service";

// Regression coverage for the Dashboard's 55-day relative-strength metric
// (see docs/DASHBOARD.md - this is the disclosed, non-proprietary
// calculation, unlike the Weekly Strong evaluator). Does not change the
// formula - only proves the current implementation's documented semantics.
function buildDailyRows(closes: number[]): MetricCandle[] {
  return closes.map((close, index) => ({
    symbol: "TEST",
    time: `2024-01-${String(index + 1).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

describe("calculate55DayChange", () => {
  it("with exactly 55 rows (the minimum sufficient count), compares the latest close to the FIRST row - 54 sessions back, 55 observations inclusive", () => {
    const closes = Array.from({ length: 55 }, (_, index) => 100 + index);
    const rows = buildDailyRows(closes);

    // base = rows[55 - 1 - 54] = rows[0] (close 100), latest = rows[54] (close 154)
    const result = calculate55DayChange(rows);

    expect(result).toBeCloseTo(((154 - 100) * 100) / 100, 10);
  });

  it("with fewer than 55 rows, the base lookup falls off the front of the array and the function returns 0 rather than throwing or producing a misleading value", () => {
    const rows = buildDailyRows(Array.from({ length: 30 }, (_, index) => 100 + index));

    expect(calculate55DayChange(rows)).toBe(0);
    // The real eligibility gate that excludes a symbol from the Dashboard's
    // relative-strength pool entirely lives at the call site
    // (computeRelativeStrengthMetrics: `if (dailyRows.length <= 54) return null;`,
    // exactly CHANGE_55D_LOOKBACK_BARS) - this test only proves the pure
    // function's own graceful behavior when called with insufficient rows.
    expect(rows.length).toBeLessThanOrEqual(CHANGE_55D_LOOKBACK_BARS);
  });

  it("computes a positive change correctly when the latest close is above the 54-sessions-ago close", () => {
    const closes = Array.from({ length: 60 }, (_, index) => (index === 5 ? 200 : 100));
    // latest = rows[59] (close 100), base = rows[59-54]=rows[5] (close 200) -
    // use a series where the base is clearly identifiable and latest is higher.
    const rows = buildDailyRows(
      Array.from({ length: 60 }, (_, index) => (index === 5 ? 100 : index === 59 ? 150 : 120))
    );

    const result = calculate55DayChange(rows);
    const expected = ((150 - 100) * 100) / 100;
    expect(result).toBeCloseTo(expected, 10);
    expect(result).toBeGreaterThan(0);
  });

  it("computes a negative change correctly when the latest close is below the 54-sessions-ago close", () => {
    const rows = buildDailyRows(
      Array.from({ length: 60 }, (_, index) => (index === 5 ? 200 : index === 59 ? 150 : 120))
    );

    const result = calculate55DayChange(rows);
    const expected = ((150 - 200) * 100) / 200;
    expect(result).toBeCloseTo(expected, 10);
    expect(result).toBeLessThan(0);
  });

  it("returns 0 (not NaN/Infinity) when the base close is exactly zero", () => {
    const rows = buildDailyRows(
      Array.from({ length: 60 }, (_, index) => (index === 5 ? 0 : index === 59 ? 150 : 120))
    );

    expect(calculate55DayChange(rows)).toBe(0);
  });

  it("returns 0 when the rows array is completely empty", () => {
    expect(calculate55DayChange([])).toBe(0);
  });

  it("uses index length-1-54 for the base row, not length-55 or length-54, matching the documented 54-trading-sessions-back semantics exactly", () => {
    // 100 rows: base should be rows[100-1-54] = rows[45].
    const closes = Array.from({ length: 100 }, (_, index) => index);
    const rows = buildDailyRows(closes);

    const result = calculate55DayChange(rows);
    const base = 45;
    const latest = 99;
    expect(result).toBeCloseTo(((latest - base) * 100) / base, 10);
  });
});
