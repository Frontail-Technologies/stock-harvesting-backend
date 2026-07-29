import { describe, expect, it } from "vitest";

import { aggregateMonthlyCandles, aggregateWeeklyCandles } from "./candle-aggregation";

describe("candle aggregation", () => {
  it("creates weekly candles from daily candles", () => {
    const [weekly] = aggregateWeeklyCandles([
      { time: "2026-07-13", open: 100, high: 110, low: 95, close: 105, volume: 10 },
      { time: "2026-07-14", open: 106, high: 120, low: 101, close: 112, volume: 15 },
      { time: "2026-07-17", open: 113, high: 118, low: 90, close: 108, volume: 20 },
    ]);

    expect(weekly).toEqual({
      time: "2026-07-13",
      open: 100,
      high: 120,
      low: 90,
      close: 108,
      volume: 45,
    });
  });

  it("creates monthly candles from daily candles", () => {
    const [monthly] = aggregateMonthlyCandles([
      { time: "2026-07-01", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: "2026-07-31", open: 11, high: 15, low: 8, close: 14, volume: 200 },
    ]);

    expect(monthly.close).toBe(14);
    expect(monthly.volume).toBe(300);
  });
});
