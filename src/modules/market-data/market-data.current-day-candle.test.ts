import { beforeEach, describe, expect, it, vi } from "vitest";

// Chart-only, provider-delayed, same-day overlay candle. Must never be
// persisted (Scanner/Weekly Strong/completed-week calculations only ever
// read from the candles table, so simply never calling upsertCandles/
// replaceCandlesAtomically here is what keeps this data out of analytics).

const selectMock = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: { select: selectMock },
}));

vi.mock("../data-provider/data-provider.service", () => ({
  getEligibleProviderAdapter: vi.fn(),
  getActiveProviderAccessToken: vi.fn().mockResolvedValue(undefined),
  markProviderConnectionExpired: vi.fn(),
}));

vi.mock("../data-provider/data-provider-settings.service", () => ({
  recordProviderSuccess: vi.fn(),
  recordProviderFailure: vi.fn(),
}));

vi.mock("./market-data.instrument-sync", () => ({
  getOrCreateInstrument: vi.fn(),
  ensureInstrumentsForSymbols: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn().mockResolvedValue(new Map()),
  refreshLatestInstrumentStats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./market-data.candles", () => ({
  readCandleHistoryRange: vi.fn(),
  readCandleDatesInRange: vi.fn(),
  replaceCandlesAtomically: vi.fn().mockResolvedValue(undefined),
  upsertCandles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./trading-calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./trading-calendar")>();
  return {
    ...actual,
    getLatestExpectedTradingDay: vi.fn(),
    getExchangeTodayIfTradingDay: vi.fn(),
  };
});

vi.mock("./dashboard-snapshot-store", () => ({
  deleteDashboardSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../market-stream/market-stream-candles", () => ({
  readCurrentDayCandle: vi.fn(),
  applyProviderDailyCandle: vi.fn(),
}));

vi.mock("../market-stream/market-stream.hub", () => ({
  publishMarketStreamEvent: vi.fn(),
}));

vi.mock("../market-stream/market-stream.service", () => ({
  ensureMarketStreamSymbols: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../market-stream/market-stream.capabilities", () => ({
  isProviderCapabilityCoolingDown: vi.fn().mockReturnValue(false),
}));

import * as providerServiceModule from "../data-provider/data-provider.service";
import * as candlesModule from "./market-data.candles";
import * as instrumentsModule from "./market-data.instruments";
import * as tradingCalendarModule from "./trading-calendar";
import * as marketStreamCandlesModule from "../market-stream/market-stream-candles";
import * as marketStreamHubModule from "../market-stream/market-stream.hub";
import * as marketStreamServiceModule from "../market-stream/market-stream.service";
import * as marketStreamCapabilitiesModule from "../market-stream/market-stream.capabilities";
import * as dataProviderSettingsModule from "../data-provider/data-provider-settings.service";
import { fetchCurrentDayDelayedCandle } from "./market-data.candle-sync";

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const upsertCandles = vi.mocked(candlesModule.upsertCandles);
const replaceCandlesAtomically = vi.mocked(candlesModule.replaceCandlesAtomically);
const readCandleDatesInRange = vi.mocked(candlesModule.readCandleDatesInRange);
const getInstrumentsBySymbol = vi.mocked(instrumentsModule.getInstrumentsBySymbol);
const getLatestExpectedTradingDay = vi.mocked(tradingCalendarModule.getLatestExpectedTradingDay);
const getExchangeTodayIfTradingDay = vi.mocked(tradingCalendarModule.getExchangeTodayIfTradingDay);
const readCurrentDayCandle = vi.mocked(marketStreamCandlesModule.readCurrentDayCandle);
const applyProviderDailyCandle = vi.mocked(marketStreamCandlesModule.applyProviderDailyCandle);
const publishMarketStreamEvent = vi.mocked(marketStreamHubModule.publishMarketStreamEvent);
const ensureMarketStreamSymbols = vi.mocked(marketStreamServiceModule.ensureMarketStreamSymbols);
const isProviderCapabilityCoolingDown = vi.mocked(marketStreamCapabilitiesModule.isProviderCapabilityCoolingDown);
const recordProviderFailure = vi.mocked(dataProviderSettingsModule.recordProviderFailure);

beforeEach(() => {
  vi.clearAllMocks();
  ensureMarketStreamSymbols.mockResolvedValue(undefined);
  readCurrentDayCandle.mockReturnValue(null);
  isProviderCapabilityCoolingDown.mockReturnValue(false);
  getEligibleProviderAdapter.mockResolvedValue(undefined as never);
  getInstrumentsBySymbol.mockResolvedValue(new Map());
  readCandleDatesInRange.mockResolvedValue(new Set());
});

describe("fetchCurrentDayDelayedCandle", () => {
  it("1. market open + a current-day delayed quote is available -> returns a provisional candle for today", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15"); // before close - today not yet completed
    readCurrentDayCandle.mockReturnValue({
      exchange: "BSE",
      symbol: "TCS",
      timeframe: "1D",
      time: "2026-09-16",
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 5000,
      lastUpdatedAt: "2026-09-16T09:45:00.000Z",
    });

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });

    expect(ensureMarketStreamSymbols).toHaveBeenCalledWith([{ exchange: "BSE", symbol: "TCS" }]);
    expect(result).toEqual({
      time: "2026-09-16",
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 5000,
      lastUpdatedAt: "2026-09-16T09:45:00.000Z",
      provisional: true,
    });
  });

  it("2. current-day quote absent from the provider -> returns null (chart safely ends on the previous completed day)", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    readCurrentDayCandle.mockReturnValue(null);

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(result).toBeNull();
  });

  it("does not resubscribe while GDF current-day capability is cooling down", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    isProviderCapabilityCoolingDown.mockReturnValue(true);

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(result).toBeNull();
    expect(ensureMarketStreamSymbols).not.toHaveBeenCalled();
    expect(readCurrentDayCandle).not.toHaveBeenCalled();
  });

  it("waits briefly after subscribing so chart open can return a just-arrived delayed candle", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    readCurrentDayCandle
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        exchange: "BSE",
        symbol: "TCS",
        timeframe: "1D",
        time: "2026-09-16",
        open: 100,
        high: 106,
        low: 99,
        close: 105,
        volume: 3000,
        lastUpdatedAt: "2026-09-16T07:45:00.000Z",
      });

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 300 });

    expect(result).toMatchObject({
      time: "2026-09-16",
      open: 100,
      high: 106,
      low: 99,
      close: 105,
      volume: 3000,
      lastUpdatedAt: "2026-09-16T07:45:00.000Z",
      provisional: true,
    });
  });

  it("returns null on a weekend - no session to show a provisional candle for", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue(null);

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(result).toBeNull();
    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
  });

  it("6. today's completed candle already exists in the DB -> defers to the normal completed-candle flow, no duplicate provisional", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-16");
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "instrument-1" } as never]]));
    readCandleDatesInRange.mockResolvedValue(new Set(["2026-09-16"]));

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(result).toBeNull();
    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
  });

  it("TITAN regression: after market close, GetHistory has not yet settled today's row (DB still has no row for today) -> the provisional snapshot is still fetched, not suppressed", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-16"); // after close, per calendar - but GetHistory hasn't settled yet
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TITAN", { id: "instrument-titan" } as never]]));
    readCandleDatesInRange.mockResolvedValue(new Set(["2026-09-10", "2026-09-11", "2026-09-15"])); // no 2026-09-16 row yet
    const fetchDelayedSnapshot = vi.fn().mockResolvedValue([
      { symbol: "TITAN", tradeTime: "2026-09-16T09:59:00.000Z", open: 5015.7, high: 5015.7, low: 4850, close: 4914.95, volume: 62 },
    ]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchDelayedSnapshot } as never);
    readCurrentDayCandle.mockReturnValue({
      exchange: "BSE", symbol: "TITAN", timeframe: "1D", time: "2026-09-16",
      open: 5015.7, high: 5015.7, low: 4850, close: 4914.95, volume: 62, lastUpdatedAt: "2026-09-16T09:59:00.000Z",
    });

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TITAN", exchange: "BSE" });

    expect(fetchDelayedSnapshot).toHaveBeenCalledWith({ symbols: ["TITAN"], exchangeCode: "BSE" });
    expect(result).toMatchObject({ time: "2026-09-16", close: 4914.95, provisional: true });
  });

  it("4. previous trading day's in-memory provisional candle is not returned on the next trading day", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-17");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-16");
    readCurrentDayCandle.mockReturnValue(null);

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(readCurrentDayCandle).toHaveBeenCalledWith({ exchange: "BSE", symbol: "TCS", date: "2026-09-17" });
    expect(result).toBeNull();
  });

  it("returns null when stream subscription fails", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    ensureMarketStreamSymbols.mockRejectedValue(new Error("stream unavailable"));

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });

    expect(result).toBeNull();
  });

  it("returns null and does not throw when live state is missing", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    readCurrentDayCandle.mockReturnValue(null);

    await expect(fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 })).resolves.toBeNull();
  });

  it("5. a second call (e.g. manual Refresh) reflects a newly updated delayed close, not a stale cached value", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    readCurrentDayCandle
      .mockReturnValueOnce({ exchange: "BSE", symbol: "TCS", timeframe: "1D", time: "2026-09-16", open: 100, high: 102, low: 99, close: 101, volume: 1000, lastUpdatedAt: "2026-09-16T09:45:00.000Z" })
      .mockReturnValueOnce({ exchange: "BSE", symbol: "TCS", timeframe: "1D", time: "2026-09-16", open: 100, high: 106, low: 99, close: 105, volume: 3000, lastUpdatedAt: "2026-09-16T10:15:00.000Z" });

    const first = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });
    const second = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });

    expect(first?.close).toBe(101);
    expect(second?.close).toBe(105);
    expect(readCurrentDayCandle).toHaveBeenCalledTimes(2);
  });

  it("3/4. never writes to the canonical candles table - Scanner/Weekly Strong (which only read from it) can never see a provisional candle", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    readCurrentDayCandle.mockReturnValue({
      exchange: "BSE",
      symbol: "TCS",
      timeframe: "1D",
      time: "2026-09-16",
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 5000,
      lastUpdatedAt: "2026-09-16T09:45:00.000Z",
    });

    await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });

    expect(upsertCandles).not.toHaveBeenCalled();
    expect(replaceCandlesAtomically).not.toHaveBeenCalled();
  });

  it("prefers a GetSnapshot (Delayed) point query over waiting on the passive stream, and feeds it into shared candle state", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    const fetchDelayedSnapshot = vi.fn().mockResolvedValue([
      { symbol: "TCS", tradeTime: "2026-09-16T09:59:00.000Z", open: 2274, high: 2275, low: 2270, close: 2274.5, volume: 100 },
    ]);
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "global-datafeeds",
      fetchDelayedSnapshot,
    } as never);
    applyProviderDailyCandle.mockReturnValue({
      type: "market.candle.update",
      data: { exchange: "BSE", symbol: "TCS", timeframe: "1D", time: "2026-09-16", open: 2274, high: 2275, low: 2270, close: 2274.5, volume: 100, lastUpdatedAt: "2026-09-16T09:59:00.000Z" },
    });
    readCurrentDayCandle.mockReturnValue({
      exchange: "BSE",
      symbol: "TCS",
      timeframe: "1D",
      time: "2026-09-16",
      open: 2274,
      high: 2275,
      low: 2270,
      close: 2274.5,
      volume: 100,
      lastUpdatedAt: "2026-09-16T09:59:00.000Z",
    });

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });

    expect(fetchDelayedSnapshot).toHaveBeenCalledWith({ symbols: ["TCS"], exchangeCode: "BSE" });
    expect(applyProviderDailyCandle).toHaveBeenCalledWith(
      expect.objectContaining({ exchange: "BSE", symbol: "TCS", open: 2274, close: 2274.5 })
    );
    expect(publishMarketStreamEvent).toHaveBeenCalled();
    expect(result?.close).toBe(2274.5);
  });

  it("falls back to the passive stream wait when GetSnapshot returns nothing for the symbol", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    const fetchDelayedSnapshot = vi.fn().mockResolvedValue([]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchDelayedSnapshot } as never);
    readCurrentDayCandle.mockReturnValue(null);

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(applyProviderDailyCandle).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("a GetSnapshot failure surfaces through the existing provider error tracking and still falls back to the stream", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    const fetchDelayedSnapshot = vi.fn().mockRejectedValue(new Error("GetSnapshot failed"));
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchDelayedSnapshot } as never);
    readCurrentDayCandle.mockReturnValue(null);

    const result = await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE", waitMs: 0 });

    expect(recordProviderFailure).toHaveBeenCalledWith("global-datafeeds", expect.any(String));
    expect(result).toBeNull();
  });

  it("never treats the delayed snapshot as a completed daily candle write - still no canonical DB insert", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    const fetchDelayedSnapshot = vi.fn().mockResolvedValue([
      { symbol: "TCS", tradeTime: "2026-09-16T09:59:00.000Z", open: 2274, high: 2275, low: 2270, close: 2274.5, volume: 100 },
    ]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchDelayedSnapshot } as never);
    readCurrentDayCandle.mockReturnValue({
      exchange: "BSE", symbol: "TCS", timeframe: "1D", time: "2026-09-16",
      open: 2274, high: 2275, low: 2270, close: 2274.5, volume: 100, lastUpdatedAt: "2026-09-16T09:59:00.000Z",
    });

    await fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" });

    expect(upsertCandles).not.toHaveBeenCalled();
    expect(replaceCandlesAtomically).not.toHaveBeenCalled();
  });

  it("concurrent calls for the same symbol collapse into one provider request", async () => {
    getExchangeTodayIfTradingDay.mockReturnValue("2026-09-16");
    getLatestExpectedTradingDay.mockReturnValue("2026-09-15");
    readCurrentDayCandle.mockReturnValue({
      exchange: "BSE",
      symbol: "TCS",
      timeframe: "1D",
      time: "2026-09-16",
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 5000,
      lastUpdatedAt: "2026-09-16T09:45:00.000Z",
    });

    const [first, second] = await Promise.all([
      fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" }),
      fetchCurrentDayDelayedCandle({ symbol: "TCS", exchange: "BSE" }),
    ]);

    expect(first).toEqual(second);
    expect(ensureMarketStreamSymbols).toHaveBeenCalledTimes(1);
    expect(readCurrentDayCandle).toHaveBeenCalledTimes(1);
  });
});
