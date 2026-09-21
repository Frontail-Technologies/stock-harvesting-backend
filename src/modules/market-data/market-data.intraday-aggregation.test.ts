import { describe, expect, it } from "vitest";

import { aggregateBseIntradayCandles } from "./market-data.intraday-aggregation";

function sessionBars(count = 25) {
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(Date.parse("2026-09-21T03:45:00.000Z") + index * 15 * 60_000).toISOString(),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: index + 1,
  }));
}

describe("aggregateBseIntradayCandles", () => {
  it("aggregates a complete 25-bar session into one daily candle", () => {
    expect(aggregateBseIntradayCandles(sessionBars(), "2026-09-21", true)).toEqual({
      time: "2026-09-21",
      open: 100,
      high: 126,
      low: 99,
      close: 125,
      volume: 325,
    });
  });

  it("does not produce a canonical candle from an incomplete session", () => {
    expect(aggregateBseIntradayCandles(sessionBars(24), "2026-09-21", true)).toBeNull();
  });

  it("allows available bars for a provisional current-day candle", () => {
    expect(aggregateBseIntradayCandles(sessionBars(2), "2026-09-21", false)?.close).toBe(102);
  });
});
