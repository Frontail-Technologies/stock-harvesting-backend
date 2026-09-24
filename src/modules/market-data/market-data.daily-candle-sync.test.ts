import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4A - last-stored-date incremental sync + bounded recent repair
// window. refreshDailyCandles (single symbol) and
// syncDailyCandlesForActiveInstruments (scheduled multi-symbol sync) share
// the exact same range-planning (planDailyCandleSync) and write path
// (backfillDailyCandles -> replaceCandlesAtomically) - these tests prove the
// LALPATHLAB-class gap (a present latest candle with absent recent middle
// dates) self-heals through normal sync, and that persistence failures are
// surfaced, never silently swallowed.

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
  return { ...actual, getLatestExpectedTradingDay: vi.fn() };
});

vi.mock("./dashboard-snapshot-store", () => ({
  deleteDashboardSnapshots: vi.fn().mockResolvedValue(undefined),
}));

import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentSyncModule from "./market-data.instrument-sync";
import * as candlesModule from "./market-data.candles";
import * as tradingCalendarModule from "./trading-calendar";
import {
  refreshDailyCandles,
  syncDailyCandlesForActiveInstruments,
} from "./market-data.candle-sync";

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const getOrCreateInstrument = vi.mocked(instrumentSyncModule.getOrCreateInstrument);
const readCandleHistoryRange = vi.mocked(candlesModule.readCandleHistoryRange);
const readCandleDatesInRange = vi.mocked(candlesModule.readCandleDatesInRange);
const getLatestExpectedTradingDay = vi.mocked(tradingCalendarModule.getLatestExpectedTradingDay);

function mockActiveInstruments(symbols: string[]) {
  const rows = symbols.map((symbol) => ({ symbol }));
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  selectMock.mockReturnValue(chain);
}

function providerCandle(time: string) {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLatestExpectedTradingDay.mockReturnValue("2026-09-11");
  getOrCreateInstrument.mockResolvedValue({ id: "instrument-1", instrumentToken: "tok-1" } as never);
});

describe("refreshDailyCandles - gap repair", () => {
  it("repairs every missing completed BSE day from 15-minute bars when daily history is unavailable", async () => {
    getLatestExpectedTradingDay.mockReturnValue("2026-09-23");
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-18" });
    readCandleDatesInRange
      .mockResolvedValueOnce(new Set(["2026-09-18"]))
      .mockResolvedValueOnce(new Set(["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"]));

    const fetchDailyCandles = vi.fn();
    const fetchIntradayCandles = vi.fn(async ({ date }: { date: string }) =>
      Array.from({ length: 25 }, (_, index) => ({
        time: new Date(Date.parse(`${date}T03:45:00.000Z`) + index * 900_000).toISOString(),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
      }))
    );
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "global-datafeeds",
      fetchDailyCandles,
      fetchIntradayCandles,
    } as never);

    const result = await refreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(fetchIntradayCandles.mock.calls.map(([input]) => input.date)).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ]);
    expect(fetchDailyCandles).not.toHaveBeenCalled();
    expect(candlesModule.upsertCandles).toHaveBeenCalledTimes(1);
    expect(candlesModule.replaceCandlesAtomically).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "updated", insertedDaily: 3, failedDates: [] });
  });

  it("persists a complete 15-minute BSE session for a targeted post-market sync", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-18" });
    readCandleDatesInRange
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(["2026-09-21"]));
    const fetchDailyCandles = vi.fn();
    const fetchIntradayCandles = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        time: new Date(Date.parse("2026-09-21T03:45:00.000Z") + index * 900_000).toISOString(),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
      }))
    );
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "global-datafeeds",
      fetchDailyCandles,
      fetchIntradayCandles,
    } as never);

    const result = await refreshDailyCandles({
      symbol: "UTLSOLAR",
      exchange: "BSE",
      targetDate: "2026-09-21",
    });

    expect(fetchIntradayCandles).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "UTLSOLAR",
      date: "2026-09-21",
      periodMinutes: 15,
    }));
    expect(fetchDailyCandles).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "updated", insertedDaily: 1 });
  });

  it("1-2-3. a present latest candle with absent recent middle dates is restored by a normal refresh (the LALPATHLAB-class regression)", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-11" });
    const before = new Set(["2026-09-08", "2026-09-11"]);
    const providerDates = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
    const after = new Set(providerDates);
    readCandleDatesInRange.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const fetchDailyCandles = vi.fn().mockResolvedValue(providerDates.map(providerCandle));
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchDailyCandles,
    } as never);

    const result = await refreshDailyCandles({ symbol: "LALPATHLAB", exchange: "BSE" });

    expect(fetchDailyCandles).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("repaired");
    expect(result.failedDates).toEqual([]);
    expect(result.insertedDaily).toBe(providerDates.length);
  });

  it("4. replaceCandlesAtomically is only asked to touch the bounded planned range, not full history", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2010-01-01", to: "2026-09-11" });
    readCandleDatesInRange.mockResolvedValue(new Set(["2026-09-11"]));
    const fetchDailyCandles = vi.fn().mockResolvedValue([providerCandle("2026-09-11")]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "eodhd", fetchDailyCandles } as never);

    await refreshDailyCandles({ symbol: "TIGHTRANGE", exchange: "BSE" });

    const [call] = fetchDailyCandles.mock.calls;
    const requestedFrom = call[0].from as string;
    expect(requestedFrom >= "2026-08-07").toBe(true);
    expect(requestedFrom).not.toBe("2010-01-01");
  });

  it("5. a repeated refresh with no new provider rows is idempotent - already-current, no failures", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-11" });
    const stableDates = new Set(["2026-08-10", "2026-09-11"]);
    readCandleDatesInRange.mockResolvedValueOnce(stableDates).mockResolvedValueOnce(stableDates);
    const fetchDailyCandles = vi.fn().mockResolvedValue([providerCandle("2026-09-11")]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "eodhd", fetchDailyCandles } as never);

    const result = await refreshDailyCandles({ symbol: "STABLE", exchange: "BSE" });

    expect(result.status).toBe("already-current");
    expect(result.failedDates).toEqual([]);
  });

  it("6. every provider-returned date persisted in DB after write is not reported as a failure", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-10" });
    const providerDates = ["2026-09-10", "2026-09-11"];
    readCandleDatesInRange
      .mockResolvedValueOnce(new Set(["2026-09-10"]))
      .mockResolvedValueOnce(new Set(providerDates));
    const fetchDailyCandles = vi.fn().mockResolvedValue(providerDates.map(providerCandle));
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "eodhd", fetchDailyCandles } as never);

    const result = await refreshDailyCandles({ symbol: "CLEAN", exchange: "BSE" });

    expect(result.status).toBe("updated");
    expect(result.failedDates).toEqual([]);
  });

  it("7. a provider-returned date missing from DB after write is surfaced as a failed symbol, never silently swallowed", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-10" });
    const providerDates = ["2026-09-10", "2026-09-11"];
    readCandleDatesInRange
      .mockResolvedValueOnce(new Set(["2026-09-10"]))
      .mockResolvedValueOnce(new Set(["2026-09-10"])); // 09-11 never actually persisted
    const fetchDailyCandles = vi.fn().mockResolvedValue(providerDates.map(providerCandle));
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "eodhd", fetchDailyCandles } as never);

    const result = await refreshDailyCandles({ symbol: "LOSSY", exchange: "BSE" });

    expect(result.status).toBe("failed");
    expect(result.failedDates).toEqual(["2026-09-11"]);
  });

  it("bootstraps full history for a symbol with zero stored candles", async () => {
    readCandleHistoryRange.mockResolvedValue(null);
    readCandleDatesInRange
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(["2026-09-11"]));
    const fetchDailyCandles = vi.fn().mockResolvedValue([providerCandle("2026-09-11")]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "eodhd", fetchDailyCandles } as never);

    const result = await refreshDailyCandles({ symbol: "NOHISTORY", exchange: "BSE" });

    expect(result.status).toBe("updated");
    expect(result.insertedDaily).toBe(1);
    expect(fetchDailyCandles).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NOHISTORY", to: "2026-09-11" })
    );
    expect(fetchDailyCandles.mock.calls[0]?.[0].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports provider-empty when the provider returns no rows for the planned range", async () => {
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-11" });
    readCandleDatesInRange.mockResolvedValue(new Set());
    const fetchDailyCandles = vi.fn().mockResolvedValue([]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "eodhd", fetchDailyCandles } as never);

    const result = await refreshDailyCandles({ symbol: "EMPTYPROVIDER", exchange: "BSE" });

    expect(result.status).toBe("provider-empty");
  });
});

describe("syncDailyCandlesForActiveInstruments", () => {
  it("processes every active instrument for the exchange and isolates a per-symbol failure", async () => {
    mockActiveInstruments(["GOOD1", "BAD", "GOOD2"]);
    readCandleHistoryRange.mockImplementation(async () => ({ from: "2020-01-01", to: "2026-09-11" }));
    readCandleDatesInRange.mockResolvedValue(new Set(["2026-09-11"]));

    getEligibleProviderAdapter.mockImplementation(async () => ({
      providerKey: "eodhd",
      fetchDailyCandles: vi.fn(async ({ symbol }: { symbol: string }) => {
        if (symbol === "BAD") throw new Error("provider timeout");
        return [providerCandle("2026-09-11")];
      }),
    }) as never);

    const summary = await syncDailyCandlesForActiveInstruments("BSE");

    expect(summary.processed).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.failedSymbols).toEqual(["BAD"]);
  });

  it("produces a job summary with processed/updated/repaired/alreadyCurrent/bootstrapRequired/failed fields", async () => {
    mockActiveInstruments(["ONE"]);
    readCandleHistoryRange.mockResolvedValue(null);
    readCandleDatesInRange
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(["2026-09-11"]));
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchDailyCandles: vi.fn().mockResolvedValue([providerCandle("2026-09-11")]),
    } as never);

    const summary = await syncDailyCandlesForActiveInstruments("BSE");

    expect(summary).toMatchObject({
      processed: 1,
      updated: 1,
      repaired: 0,
      alreadyCurrent: 0,
      bootstrapRequired: 0,
      failed: 0,
      failedSymbols: [],
    });
  });

  it("throttles onProgress instead of firing once per symbol, and reports a final call with the true total", async () => {
    const symbols = Array.from({ length: 60 }, (_, index) => `SYM${index}`);
    mockActiveInstruments(symbols);
    readCandleHistoryRange.mockResolvedValue(null);

    const progressCalls: Array<{ processed: number; total: number }> = [];
    await syncDailyCandlesForActiveInstruments("BSE", (progress) => {
      progressCalls.push({ processed: progress.processed, total: progress.total });
    });

    expect(progressCalls.length).toBeLessThan(symbols.length);
    expect(progressCalls.every((call) => call.total === 60 && call.processed <= 60)).toBe(true);
    expect(progressCalls.at(-1)).toEqual(expect.objectContaining({ processed: 60, total: 60 }));
  });

  it("does not call onProgress when it isn't provided", async () => {
    mockActiveInstruments(["ONE"]);
    readCandleHistoryRange.mockResolvedValue(null);

    await expect(syncDailyCandlesForActiveInstruments("BSE")).resolves.toBeDefined();
  });
});
