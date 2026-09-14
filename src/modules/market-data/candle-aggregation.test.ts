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

describe("aggregateWeeklyCandles - canonical weekly bucket timestamp", () => {
  it("a complete Mon-Fri week buckets to its Monday", () => {
    const [weekly] = aggregateWeeklyCandles([
      { time: "2026-08-24", open: 400, high: 405, low: 398, close: 401.55, volume: 100 },
      { time: "2026-08-25", open: 401, high: 406, low: 399, close: 402, volume: 110 },
      { time: "2026-08-26", open: 402, high: 417, low: 400, close: 416.2, volume: 120 },
      { time: "2026-08-27", open: 416, high: 424, low: 415, close: 423.3, volume: 130 },
      { time: "2026-08-28", open: 423, high: 425, low: 421, close: 423.75, volume: 140 },
    ]);

    expect(weekly.time).toBe("2026-08-24");
  });

  it("Monday missing, Tue-Fri available - weekly time is still the canonical Monday", () => {
    const [weekly] = aggregateWeeklyCandles([
      { time: "2026-08-25", open: 401, high: 406, low: 399, close: 402, volume: 110 },
      { time: "2026-08-26", open: 402, high: 417, low: 400, close: 416.2, volume: 120 },
      { time: "2026-08-27", open: 416, high: 424, low: 415, close: 423.3, volume: 130 },
      { time: "2026-08-28", open: 423, high: 425, low: 421, close: 423.75, volume: 140 },
    ]);

    expect(weekly.time).toBe("2026-08-24");
  });

  it("only Tuesday and Friday available - weekly time is still the canonical Monday, OHLCV from only those rows", () => {
    const [weekly] = aggregateWeeklyCandles([
      { time: "2026-09-01", open: 424, high: 425, low: 423, close: 424.7, volume: 200 },
      { time: "2026-09-04", open: 424, high: 426, low: 422, close: 424.85, volume: 210 },
    ]);

    expect(weekly.time).toBe("2026-08-31");
    expect(weekly.open).toBe(424); // first ACTUAL row's open (2026-09-01) - never fabricated for the missing Monday
    expect(weekly.close).toBe(424.85); // last actual row's close (2026-09-04)
    expect(weekly.high).toBe(426);
    expect(weekly.low).toBe(422);
    expect(weekly.volume).toBe(410);
  });

  it("adjacent weeks produce the canonical sequence Aug 24 -> Aug 31 -> Sep 7, even with a missing Monday", () => {
    const weekly = aggregateWeeklyCandles([
      { time: "2026-08-24", open: 400, high: 405, low: 398, close: 401.55, volume: 100 },
      { time: "2026-08-28", open: 423, high: 425, low: 421, close: 423.75, volume: 140 },
      { time: "2026-09-01", open: 424, high: 425, low: 423, close: 424.7, volume: 200 }, // Mon 2026-08-31 missing
      { time: "2026-09-04", open: 424, high: 426, low: 422, close: 424.85, volume: 210 },
      { time: "2026-09-07", open: 422, high: 423, low: 420, close: 422.3, volume: 150 },
    ]);

    expect(weekly.map((row) => row.time)).toEqual(["2026-08-24", "2026-08-31", "2026-09-07"]);
  });

  it("does not affect monthly bucketing - aggregateMonthlyCandles still buckets by first available daily row", () => {
    const [monthly] = aggregateMonthlyCandles([
      { time: "2026-09-01", open: 424, high: 425, low: 423, close: 424.7, volume: 200 },
    ]);

    expect(monthly.time).toBe("2026-09-01");
  });
});
