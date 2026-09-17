import { describe, expect, it } from "vitest";

import {
  applyProviderDailyCandle,
  applyTickToCandles,
  countCurrentDayCandlesInMemory,
  readCurrentDayCandle,
} from "./market-stream-candles";

describe("market stream current-day candles", () => {
  it("first tick creates provisional OHLC", () => {
    applyTickToCandles({
      exchange: "BSE",
      symbol: "TCS",
      price: 100,
      time: "2026-09-16T09:30:00.000Z",
    });

    expect(readCurrentDayCandle({ exchange: "BSE", symbol: "TCS", date: "2026-09-16" })).toMatchObject({
      time: "2026-09-16",
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    });
  });

  it("later ticks update high low and close", () => {
    applyTickToCandles({
      exchange: "BSE",
      symbol: "RELIANCE",
      price: 100,
      time: "2026-09-16T09:30:00.000Z",
    });
    applyTickToCandles({
      exchange: "BSE",
      symbol: "RELIANCE",
      price: 110,
      time: "2026-09-16T09:45:00.000Z",
    });
    applyTickToCandles({
      exchange: "BSE",
      symbol: "RELIANCE",
      price: 95,
      time: "2026-09-16T10:00:00.000Z",
    });

    expect(readCurrentDayCandle({ exchange: "BSE", symbol: "RELIANCE", date: "2026-09-16" })).toMatchObject({
      open: 100,
      high: 110,
      low: 95,
      close: 95,
    });
  });

  it("different dates keep separate daily candles", () => {
    applyTickToCandles({
      exchange: "BSE",
      symbol: "LALPATHLAB",
      price: 100,
      time: "2026-09-16T09:30:00.000Z",
    });
    applyTickToCandles({
      exchange: "BSE",
      symbol: "LALPATHLAB",
      price: 120,
      time: "2026-09-17T09:30:00.000Z",
    });

    expect(readCurrentDayCandle({ exchange: "BSE", symbol: "LALPATHLAB", date: "2026-09-16" })?.close).toBe(100);
    expect(readCurrentDayCandle({ exchange: "BSE", symbol: "LALPATHLAB", date: "2026-09-17" })?.open).toBe(120);
  });

  it("provider OHLC overrides reconstructed tick open high and low", () => {
    applyTickToCandles({
      exchange: "BSE",
      symbol: "PROVIDER",
      price: 150,
      time: "2026-09-16T10:30:00.000Z",
    });
    applyProviderDailyCandle({
      exchange: "BSE",
      symbol: "PROVIDER",
      time: "2026-09-16T10:31:00.000Z",
      open: 140,
      high: 160,
      low: 135,
      close: 155,
      volume: 12345,
    });

    expect(readCurrentDayCandle({ exchange: "BSE", symbol: "PROVIDER", date: "2026-09-16" })).toMatchObject({
      open: 140,
      high: 160,
      low: 135,
      close: 155,
      volume: 12345,
    });
  });

  it("counts in-memory current-day candles by exchange", () => {
    const exchange = `BSE_COUNT_${Date.now()}`;
    applyProviderDailyCandle({
      exchange,
      symbol: "ONE",
      time: "2026-09-16T10:31:00.000Z",
      open: 1,
      high: 2,
      low: 1,
      close: 2,
    });
    applyProviderDailyCandle({
      exchange,
      symbol: "TWO",
      time: "2026-09-16T10:32:00.000Z",
      open: 1,
      high: 3,
      low: 1,
      close: 3,
    });

    expect(countCurrentDayCandlesInMemory(exchange)).toBe(2);
  });
});
