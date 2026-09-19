import { beforeEach, describe, expect, it, vi } from "vitest";

// Bootstrap no-history classification. GetHistory outcomes:
//   candles returned            -> persisted, no-history state cleared
//   successful empty response   -> the ONLY case remembered as "no history"
//   provider error / timeout    -> thrown, never remembered (stays retryable)
//   persistence failure         -> "failed", never remembered (stays retryable)

const selectMock = vi.hoisted(() => vi.fn());
const noHistory = vi.hoisted(() => ({
  readNoHistoryConfirmedAt: vi.fn(),
  recordNoHistoryConfirmed: vi.fn(),
  clearNoHistory: vi.fn(),
}));

vi.mock("../../db/client", () => ({ db: { select: selectMock } }));
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
  return { ...actual, getLatestExpectedTradingDay: vi.fn() };
});
vi.mock("./dashboard-snapshot-store", () => ({ deleteDashboardSnapshots: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./market-data.no-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market-data.no-history")>();
  return { ...actual, ...noHistory };
});

import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentSyncModule from "./market-data.instrument-sync";
import * as candlesModule from "./market-data.candles";
import * as tradingCalendarModule from "./trading-calendar";
import { refreshDailyCandles } from "./market-data.candle-sync";

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const getOrCreateInstrument = vi.mocked(instrumentSyncModule.getOrCreateInstrument);
const readCandleHistoryRange = vi.mocked(candlesModule.readCandleHistoryRange);
const readCandleDatesInRange = vi.mocked(candlesModule.readCandleDatesInRange);
const replaceCandlesAtomically = vi.mocked(candlesModule.replaceCandlesAtomically);
const getLatestExpectedTradingDay = vi.mocked(tradingCalendarModule.getLatestExpectedTradingDay);

const candle = (time: string) => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function useAdapter(fetchDailyCandles: ReturnType<typeof vi.fn>) {
  getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchDailyCandles } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  getLatestExpectedTradingDay.mockReturnValue("2026-09-18");
  getOrCreateInstrument.mockResolvedValue({ id: "instrument-1", instrumentToken: "1000EQ" } as never);
  readCandleHistoryRange.mockResolvedValue(null as never); // no stored candles -> bootstrap
  readCandleDatesInRange.mockResolvedValue(new Set());
  noHistory.readNoHistoryConfirmedAt.mockResolvedValue(null);
  noHistory.recordNoHistoryConfirmed.mockResolvedValue(undefined);
  noHistory.clearNoHistory.mockResolvedValue(undefined);
});

describe("successful empty GetHistory", () => {
  it("is remembered as no-history and reported provider-empty, not as an error", async () => {
    const fetchDailyCandles = vi.fn().mockResolvedValue([]);
    useAdapter(fetchDailyCandles);

    const result = await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(result.status).toBe("provider-empty");
    expect(fetchDailyCandles).toHaveBeenCalledTimes(1);
    expect(noHistory.recordNoHistoryConfirmed).toHaveBeenCalledTimes(1);
    expect(noHistory.recordNoHistoryConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ exchange: "BSE_IDX", symbol: "1000EQ", requestedTo: "2026-09-18" })
    );
  });

  it("does not re-bootstrap (GDF is not called) while the confirmation is fresh - the next reconcile pass or a restarted worker", async () => {
    const fetchDailyCandles = vi.fn().mockResolvedValue([]);
    useAdapter(fetchDailyCandles);
    noHistory.readNoHistoryConfirmedAt.mockResolvedValue(daysAgo(1));

    const result = await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(result.status).toBe("provider-empty");
    expect(fetchDailyCandles).not.toHaveBeenCalled();
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });

  it("becomes eligible for a recheck once the recheck interval has passed", async () => {
    const fetchDailyCandles = vi.fn().mockResolvedValue([]);
    useAdapter(fetchDailyCandles);
    noHistory.readNoHistoryConfirmedAt.mockResolvedValue(daysAgo(8));

    await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(fetchDailyCandles).toHaveBeenCalledTimes(1);
    expect(noHistory.recordNoHistoryConfirmed).toHaveBeenCalledTimes(1);
  });

  it("an explicit recheck (admin per-symbol refresh) queries GlobalDataFeeds even while the confirmation is fresh", async () => {
    const fetchDailyCandles = vi.fn().mockResolvedValue([]);
    useAdapter(fetchDailyCandles);
    noHistory.readNoHistoryConfirmedAt.mockResolvedValue(daysAgo(1));

    await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX", forceRecheck: true });

    expect(fetchDailyCandles).toHaveBeenCalledTimes(1);
  });

  it("history appearing later persists normally and clears the no-history state", async () => {
    const dates = ["2026-09-17", "2026-09-18"];
    readCandleDatesInRange.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(dates));
    const fetchDailyCandles = vi.fn().mockResolvedValue(dates.map(candle));
    useAdapter(fetchDailyCandles);
    noHistory.readNoHistoryConfirmedAt.mockResolvedValue(daysAgo(9));

    const result = await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(result.status).toBe("updated");
    expect(replaceCandlesAtomically).toHaveBeenCalledTimes(1);
    expect(noHistory.clearNoHistory).toHaveBeenCalledWith("BSE_IDX", "1000EQ");
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });
});

describe("failures stay retryable and are never remembered as no-history", () => {
  it("provider error", async () => {
    const fetchDailyCandles = vi.fn().mockRejectedValue(new Error("Global Datafeeds returned an error"));
    useAdapter(fetchDailyCandles);

    await expect(refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" })).rejects.toThrow("returned an error");

    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });

  it("timeout / network failure", async () => {
    const fetchDailyCandles = vi.fn().mockRejectedValue(new Error("Global Datafeeds request timed out: GetHistory"));
    useAdapter(fetchDailyCandles);

    await expect(refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" })).rejects.toThrow("timed out");

    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });

  it("a timeout does not hide an instrument: the next attempt still calls GlobalDataFeeds", async () => {
    const fetchDailyCandles = vi
      .fn()
      .mockRejectedValueOnce(new Error("Global Datafeeds request timed out: GetHistory"))
      .mockResolvedValueOnce([]);
    useAdapter(fetchDailyCandles);

    await expect(refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" })).rejects.toThrow();
    await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(fetchDailyCandles).toHaveBeenCalledTimes(2);
  });

  it("persistence failure (provider returned candles that did not land)", async () => {
    readCandleDatesInRange.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());
    const fetchDailyCandles = vi.fn().mockResolvedValue([candle("2026-09-17"), candle("2026-09-18")]);
    useAdapter(fetchDailyCandles);

    const result = await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(result.status).toBe("failed");
    expect(result.failedDates).toEqual(["2026-09-17", "2026-09-18"]);
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });

  it("no eligible provider is a no-op, not a confirmation that the instrument has no history", async () => {
    getEligibleProviderAdapter.mockResolvedValue(null as never);

    const result = await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" });

    expect(result.status).toBe("provider-empty");
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });

  it("an empty response for an incremental window of an instrument that HAS candles is not a no-history conclusion", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-17" });
    const fetchDailyCandles = vi.fn().mockResolvedValue([]);
    useAdapter(fetchDailyCandles);

    const result = await refreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(result.status).toBe("provider-empty");
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });
});

describe("instruments with real history still bootstrap normally", () => {
  it.each(["BSE", "BSE_IDX"])("%s: missing history is fetched and persisted through the normal path", async (exchange) => {
    const dates = ["2026-09-17", "2026-09-18"];
    readCandleDatesInRange.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(dates));
    const fetchDailyCandles = vi.fn().mockResolvedValue(dates.map(candle));
    useAdapter(fetchDailyCandles);

    const result = await refreshDailyCandles({ symbol: "ABC", exchange });

    expect(result.status).toBe("updated");
    expect(result.insertedDaily).toBe(2);
    expect(replaceCandlesAtomically).toHaveBeenCalledTimes(1);
    expect(replaceCandlesAtomically.mock.calls[0][1]).toMatchObject({ exchange, symbol: "ABC" });
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });
});
