import { beforeEach, describe, expect, it, vi } from "vitest";

// getChartCandles must stay a pure DB read (RULES.md #16, Phase 4A/4B) -
// never a provider call triggered by opening a chart. On-demand repair is
// ensureFreshDailyCandles's job, called separately by the frontend.

vi.mock("../data-provider/data-provider.service", () => ({
  getEligibleProviderAdapter: vi.fn(),
  getActiveProviderAccessToken: vi.fn(),
}));

vi.mock("./market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn(),
}));

vi.mock("./market-data.candles", () => ({
  readChartCandles: vi.fn(),
  readCandleHistoryRange: vi.fn(),
  replaceCandlesAtomically: vi.fn(),
  upsertCandles: vi.fn(),
}));

vi.mock("./trading-calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./trading-calendar")>();
  return { ...actual, isCompletedTradingWeek: vi.fn() };
});

import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentsModule from "./market-data.instruments";
import * as candlesModule from "./market-data.candles";
import * as tradingCalendarModule from "./trading-calendar";
import { getChartCandles } from "./market-data.service";

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const getActiveProviderAccessToken = vi.mocked(providerServiceModule.getActiveProviderAccessToken);
const getInstrumentsBySymbol = vi.mocked(instrumentsModule.getInstrumentsBySymbol);
const readChartCandles = vi.mocked(candlesModule.readChartCandles);
const isCompletedTradingWeek = vi.mocked(tradingCalendarModule.isCompletedTradingWeek);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every week is complete unless a test says otherwise - keeps
  // the pre-existing relabeling/dataThrough tests (which don't care about
  // completeness) working unchanged.
  isCompletedTradingWeek.mockReturnValue(true);
});

describe("getChartCandles - DB-only read path", () => {
  it("returns stored daily rows without ever touching the provider adapter", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      { time: "2026-09-10", open: 1, high: 2, low: 0, close: 1, volume: 10 },
      { time: "2026-09-11", open: 1, high: 2, low: 0, close: 1, volume: 10 },
    ] as never);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1D" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(2);
    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
    expect(getActiveProviderAccessToken).not.toHaveBeenCalled();
  });

  it("returns an empty array and null dataThrough without calling the provider when no candles are stored yet", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map());
    readChartCandles.mockResolvedValue([] as never);

    const result = await getChartCandles({ symbol: "NEWSYMBOL", timeframe: "1D" as never, exchange: "BSE" });

    expect(result).toEqual({ candles: [], dataThrough: null });
    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
    expect(getActiveProviderAccessToken).not.toHaveBeenCalled();
  });

  it("returns a stable cursor for progressively loading older daily candles", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      { time: "2026-09-10", open: 1, high: 2, low: 0, close: 1, volume: 10 },
      { time: "2026-09-11", open: 1, high: 2, low: 0, close: 1, volume: 10 },
    ] as never);

    const result = await getChartCandles({
      symbol: "TCS",
      timeframe: "1D" as never,
      exchange: "BSE",
      limit: 400,
    });

    expect(readChartCandles).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 400, before: undefined })
    );
    expect(result.nextBefore).toBe("2026-09-10");
    expect(result.hasMore).toBe(false);
  });
});

describe("getChartCandles - 1W timestamp is the week-ending Friday", () => {
  it("relabels a 1D-derived weekly candle's Monday bucket to that week's Friday", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    // Mon 07 Sep 2026 -> Fri 11 Sep 2026, one ISO week of daily bars.
    readChartCandles.mockResolvedValue([
      { time: "2026-09-07", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: "2026-09-08", open: 11, high: 13, low: 10, close: 12, volume: 100 },
      { time: "2026-09-09", open: 12, high: 14, low: 11, close: 13, volume: 100 },
      { time: "2026-09-10", open: 13, high: 15, low: 12, close: 14, volume: 100 },
      { time: "2026-09-11", open: 14, high: 16, low: 13, close: 15, volume: 100 },
    ] as never);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].time).toBe("2026-09-11");
    // OHLC/volume untouched by the display-timestamp relabel.
    expect(result.candles[0].open).toBe(10);
    expect(result.candles[0].high).toBe(16);
    expect(result.candles[0].low).toBe(9);
    expect(result.candles[0].close).toBe(15);
    expect(result.candles[0].volume).toBe(500);
  });

  it("relabels the legacy stored-1W fallback the same way, so both paths agree", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["OLDCO", { id: "i-2" } as never]]));
    readChartCandles.mockImplementation(async (input: { timeframe: string }) => {
      if (input.timeframe === "1D") return [] as never;
      // Legacy row stored under its bucket's Monday, as older provider syncs did.
      return [{ time: "2026-09-07", open: 1, high: 2, low: 0.5, close: 1.5, volume: 200 }] as never;
    });

    const result = await getChartCandles({ symbol: "OLDCO", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].time).toBe("2026-09-11");
  });

  it("leaves 1D timestamps as actual trading dates", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      { time: "2026-09-09", open: 1, high: 2, low: 0, close: 1, volume: 10 },
    ] as never);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1D" as never, exchange: "BSE" });

    expect(result.candles[0].time).toBe("2026-09-09");
  });
});

// Locked requirement: "Data through" must always be the latest ACTUAL
// underlying 1D trading-day candle, never a weekly/monthly bucket label -
// even when a completed week's own display timestamp is a Friday.
describe("getChartCandles - dataThrough reflects the latest underlying daily candle, never an aggregated bucket label", () => {
  // Sep 7-11 (a complete prior week) plus Sep 14-16 (the in-progress
  // current week) - the current week is excluded by the completeness
  // filter (see the describe block below), so the only visible 1W candle
  // is the completed 11 Sep week, while dataThrough still reflects the
  // true latest stored daily row (16 Sep).
  const TWO_WEEKS_DAILY_ROWS = [
    { time: "2026-09-07", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: "2026-09-08", open: 11, high: 13, low: 10, close: 12, volume: 100 },
    { time: "2026-09-09", open: 12, high: 14, low: 11, close: 13, volume: 100 },
    { time: "2026-09-10", open: 13, high: 15, low: 12, close: 14, volume: 100 },
    { time: "2026-09-11", open: 14, high: 16, low: 13, close: 15, volume: 100 },
    { time: "2026-09-14", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: "2026-09-15", open: 11, high: 13, low: 10, close: 12, volume: 100 },
    { time: "2026-09-16", open: 12, high: 14, low: 11, close: 13, volume: 100 },
  ] as never;

  function completedOnlyForWeekEndingSep11() {
    isCompletedTradingWeek.mockImplementation((weekCandleTime: string) => weekCandleTime === "2026-09-11");
  }

  it("1. latest daily = 16 Sep, current week ending 18 Sep is incomplete -> dataThrough = 16 Sep, latest visible week = 11 Sep", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(TWO_WEEKS_DAILY_ROWS);
    completedOnlyForWeekEndingSep11();

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].time).toBe("2026-09-11");
    expect(result.dataThrough).toBe("2026-09-16");
  });

  it("2. dataThrough is never a future date relative to the latest stored daily row", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(TWO_WEEKS_DAILY_ROWS);
    completedOnlyForWeekEndingSep11();

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.dataThrough).not.toBe("2026-09-18");
    expect(result.dataThrough! <= "2026-09-16").toBe(true);
  });

  it("3a. 1D exposes the latest underlying daily date", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(TWO_WEEKS_DAILY_ROWS);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1D" as never, exchange: "BSE" });

    expect(result.dataThrough).toBe("2026-09-16");
  });

  it("3b. 1W exposes the latest underlying daily date, not the aggregated weekly candle's own timestamp", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(TWO_WEEKS_DAILY_ROWS);
    completedOnlyForWeekEndingSep11();

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.dataThrough).toBe("2026-09-16");
  });

  it("3c. 1M exposes the latest underlying daily date, not the aggregated monthly candle's own timestamp", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(TWO_WEEKS_DAILY_ROWS);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1M" as never, exchange: "BSE" });

    expect(result.dataThrough).toBe("2026-09-16");
  });

  it("4. a completed week's own display timestamp remains the week-ending Friday regardless of dataThrough", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(TWO_WEEKS_DAILY_ROWS);
    completedOnlyForWeekEndingSep11();

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles[0].time).toBe("2026-09-11");
    expect(result.dataThrough).toBe("2026-09-16");
  });

  it("returns null dataThrough for the legacy stored-timeframe fallback (no daily rows to derive it from)", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["OLDCO", { id: "i-2" } as never]]));
    readChartCandles.mockImplementation(async (input: { timeframe: string }) => {
      if (input.timeframe === "1D") return [] as never;
      return [{ time: "2026-09-07", open: 1, high: 2, low: 0.5, close: 1.5, volume: 200 }] as never;
    });

    const result = await getChartCandles({ symbol: "OLDCO", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.dataThrough).toBeNull();
  });
});

// Locked requirement: the 1W chart must only ever expose COMPLETED weeks -
// a week becomes visible only once its own Friday has closed
// (isCompletedTradingWeek), never early under a future week-ending Friday
// label.
describe("getChartCandles - 1W excludes the in-progress/incomplete week", () => {
  const CURRENT_WEEK_IN_PROGRESS_ROWS = [
    { time: "2026-09-14", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: "2026-09-15", open: 11, high: 13, low: 10, close: 12, volume: 100 },
    { time: "2026-09-16", open: 12, high: 14, low: 11, close: 13, volume: 100 },
  ] as never;

  it("1. Wed 16 Sep - the in-progress week ending 18 Sep is excluded entirely, not shown early", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(CURRENT_WEEK_IN_PROGRESS_ROWS);
    isCompletedTradingWeek.mockReturnValue(false);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(0);
    expect(result.candles.some((candle) => candle.time === "2026-09-18")).toBe(false);
  });

  it("includes the forming weekly candle when the chart route opts in", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(CURRENT_WEEK_IN_PROGRESS_ROWS);
    isCompletedTradingWeek.mockReturnValue(false);

    const result = await getChartCandles({
      symbol: "TCS",
      timeframe: "1W" as never,
      exchange: "BSE",
      includeIncompleteWeekly: true,
    });

    expect(result.candles).toEqual([
      {
        time: "2026-09-18",
        open: 10,
        high: 14,
        low: 9,
        close: 13,
        volume: 300,
      },
    ]);
    expect(result.dataThrough).toBe("2026-09-16");
    expect(isCompletedTradingWeek).not.toHaveBeenCalled();
  });

  it("2. after Fri 18 Sep market close, the same week's candle is included, labeled 18 Sep", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      ...CURRENT_WEEK_IN_PROGRESS_ROWS,
      { time: "2026-09-17", open: 12, high: 14, low: 11, close: 13, volume: 100 },
      { time: "2026-09-18", open: 13, high: 15, low: 12, close: 14, volume: 100 },
    ] as never);
    isCompletedTradingWeek.mockReturnValue(true);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].time).toBe("2026-09-18");
  });

  it("3. no future weekly timestamp can ever be returned - every returned 1W candle passes the completeness check", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      { time: "2026-09-07", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: "2026-09-08", open: 11, high: 13, low: 10, close: 12, volume: 100 },
      { time: "2026-09-09", open: 12, high: 14, low: 11, close: 13, volume: 100 },
      { time: "2026-09-10", open: 13, high: 15, low: 12, close: 14, volume: 100 },
      { time: "2026-09-11", open: 14, high: 16, low: 13, close: 15, volume: 100 },
      ...CURRENT_WEEK_IN_PROGRESS_ROWS,
    ] as never);
    isCompletedTradingWeek.mockImplementation((weekCandleTime: string) => weekCandleTime !== "2026-09-18");

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(1);
    expect(result.candles.every((candle) => candle.time !== "2026-09-18")).toBe(true);
  });

  it("applies the same completeness rule to the legacy stored-1W fallback", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["OLDCO", { id: "i-2" } as never]]));
    readChartCandles.mockImplementation(async (input: { timeframe: string }) => {
      if (input.timeframe === "1D") return [] as never;
      // Legacy row stored under the current in-progress week's own Monday bucket.
      return [{ time: "2026-09-14", open: 1, high: 2, low: 0.5, close: 1.5, volume: 200 }] as never;
    });
    isCompletedTradingWeek.mockReturnValue(false);

    const result = await getChartCandles({ symbol: "OLDCO", timeframe: "1W" as never, exchange: "BSE" });

    expect(result.candles).toHaveLength(0);
  });

  it("does not affect 1D or 1M timeframes", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue(CURRENT_WEEK_IN_PROGRESS_ROWS);
    isCompletedTradingWeek.mockReturnValue(false);

    const daily = await getChartCandles({ symbol: "TCS", timeframe: "1D" as never, exchange: "BSE" });
    const monthly = await getChartCandles({ symbol: "TCS", timeframe: "1M" as never, exchange: "BSE" });

    expect(daily.candles).toHaveLength(3);
    expect(monthly.candles).toHaveLength(1);
    expect(isCompletedTradingWeek).not.toHaveBeenCalled();
  });
});
