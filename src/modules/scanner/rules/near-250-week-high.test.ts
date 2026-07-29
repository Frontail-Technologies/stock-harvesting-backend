import { describe, expect, it } from "vitest";

import { calculateNear250WeekHighScan } from "./near-250-week-high";

function buildWeeklyCandles(close: number) {
  return Array.from({ length: 250 }, (_, index) => ({
    time: `202${Math.floor(index / 52)}-${String((index % 52) + 1).padStart(2, "0")}-01`,
    high: index === 120 ? 1000 : Math.max(close, 700),
    close: index === 120 ? 1000 : index === 249 ? close : 700,
  }));
}

describe("near 250-week close scanner rule", () => {
  it("matches when the latest weekly close is above 85% of the 250-week closing high", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(900), 250);

    expect(result?.matched).toBe(true);
    expect(result?.metrics.highestClose250).toBe(1000);
    expect(result?.metrics.threshold85).toBe(850);
    expect(result?.metrics.currentClose).toBe(900);
    expect(result?.highlightTimes).toContain("2024-42-01");
  });

  it("matches when the latest weekly close equals 85% of the 250-week closing high", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(850), 250);

    expect(result?.matched).toBe(true);
    expect(result?.metrics.threshold85).toBe(850);
  });

  it("does not match below 85% of the 250-week closing high", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(849.99), 250);

    expect(result?.matched).toBe(false);
    expect(result?.highlightTimes).toEqual([]);
  });

  it("falls back to a 3-year lookback when 5 years are requested but only 3 years are available", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(900).slice(-150), 250);

    expect(result?.metrics.lookbackWeeks).toBe(150);
    expect(result?.matched).toBe(true);
  });

  it("falls back to a 1-year lookback when 5 years are requested but only 1 year is available", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(900).slice(-50), 250);

    expect(result?.metrics.lookbackWeeks).toBe(50);
    expect(result?.matched).toBe(true);
  });

  it("returns null until at least 1 year of weekly candles is available", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(900).slice(-49), 250);

    expect(result).toBeNull();
  });

  it("highlights every candle that closes above its rolling 250-week threshold", () => {
    const candles = buildWeeklyCandles(900).concat(
      Array.from({ length: 5 }, (_, index) => ({
        time: `2024-${String(43 + index).padStart(2, "0")}-01`,
        high: 760,
        close: index % 2 === 0 ? 900 : 800,
      }))
    );

    const result = calculateNear250WeekHighScan(candles, 250);

    expect(result?.matched).toBe(true);
    expect(result?.highlightTimes).toContain("2024-42-01");
    expect(result?.highlightTimes).toContain("2024-43-01");
    expect(result?.highlightTimes).not.toContain("2024-44-01");
    expect(result?.highlightTimes).toContain("2024-47-01");
  });

  it("keeps historical highlights when the latest weekly close is not a current match", () => {
    const candles = buildWeeklyCandles(900).concat({
      time: "2024-43-01",
      high: 760,
      close: 800,
    });

    const result = calculateNear250WeekHighScan(candles, 250);

    expect(result?.matched).toBe(false);
    expect(result?.highlightTimes).toContain("2024-42-01");
    expect(result?.highlightTimes).not.toContain("2024-43-01");
  });

  it("supports explicit shorter user-selected lookback windows", () => {
    const result = calculateNear250WeekHighScan(buildWeeklyCandles(900).slice(-50), 50);

    expect(result?.metrics.lookbackWeeks).toBe(50);
    expect(result?.matched).toBe(true);
  });
});
