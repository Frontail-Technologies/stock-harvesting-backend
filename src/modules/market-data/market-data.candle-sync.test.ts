import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * No existing test covered single-flight/dedup behavior for
 * runChartBackfillOnce/runLatestCandleRefreshOnce, or the orchestration
 * branching in syncLatestDailyCandlesForSymbols, before this extraction.
 * These functions have no injectable dbClient/adapter seam (backfillDailyCandles
 * and syncLatestDailyCandlesForSymbols resolve their provider adapter and
 * instrument dependencies via module-level imports), so - same as
 * market-data.instrument-sync.test.ts - module mocking (vi.mock) is used to
 * observe how many times the underlying provider call actually fires,
 * without changing any production code.
 *
 * The in-flight/cooldown Maps this module owns (chartBackfillPromises,
 * completedChartBackfillAtByKey, latestCandleRefreshPromises,
 * failedLatestCandleSyncAtBySymbol) are real, un-mocked module-level
 * singletons that persist for the lifetime of this test file - so every
 * test below uses a symbol name unique to itself, to avoid one test's
 * completed/failed key silently short-circuiting a later test's call.
 */

vi.mock("../data-provider/data-provider.service", () => ({
  getEligibleProviderAdapter: vi.fn(),
  getActiveProviderAccessToken: vi.fn().mockResolvedValue(undefined),
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
  replaceCandlesAtomically: vi.fn().mockResolvedValue(undefined),
  upsertCandles: vi.fn().mockResolvedValue(undefined),
}));

import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentSyncModule from "./market-data.instrument-sync";
import {
  backfillDailyCandles,
  runChartBackfillOnce,
  runLatestCandleRefreshOnce,
  syncLatestDailyCandlesForSymbols,
} from "./market-data.candle-sync";

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const getOrCreateInstrument = vi.mocked(instrumentSyncModule.getOrCreateInstrument);

beforeEach(() => {
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runChartBackfillOnce single-flight", () => {
  it("A. two simultaneous identical calls result in exactly one underlying fetchDailyCandles execution", async () => {
    let fetchCallCount = 0;
    const gate = deferred<void>();
    const fetchDailyCandles = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      await gate.promise;
      return [];
    });

    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchDailyCandles,
    } as never);
    getOrCreateInstrument.mockResolvedValue({ id: "i-a", instrumentToken: "tok-a" } as never);

    const input = { symbol: "BF_SYM_A", from: "2024-01-01", to: "2024-06-01", exchange: "NSE" };

    const first = runChartBackfillOnce(input);
    const second = runChartBackfillOnce(input);

    expect(first).toBe(second); // same in-flight promise reference

    gate.resolve();
    await Promise.all([first, second]);

    expect(fetchCallCount).toBe(1);
  });

  it("C. immediately repeating the same call after it settles is skipped by the completed-backfill cooldown, not re-executed", async () => {
    let fetchCallCount = 0;
    const fetchDailyCandles = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      return [];
    });

    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchDailyCandles,
    } as never);
    getOrCreateInstrument.mockResolvedValue({ id: "i-c", instrumentToken: "tok-c" } as never);

    const input = { symbol: "BF_SYM_C", from: "2024-01-01", to: "2024-06-01", exchange: "NSE" };

    await runChartBackfillOnce(input);
    expect(fetchCallCount).toBe(1);

    const secondResult = await runChartBackfillOnce(input);
    expect(secondResult).toEqual({ skipped: true });
    expect(fetchCallCount).toBe(1); // no second provider call
  });

  it("different symbol/date-range keys run independently (no cross-key blocking)", async () => {
    let fetchCallCount = 0;
    const fetchDailyCandles = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      return [];
    });

    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchDailyCandles,
    } as never);
    getOrCreateInstrument.mockResolvedValue({ id: "i-key", instrumentToken: "tok-key" } as never);

    await Promise.all([
      runChartBackfillOnce({ symbol: "BF_SYM_KEY1", from: "2024-01-01", to: "2024-06-01", exchange: "NSE" }),
      runChartBackfillOnce({ symbol: "BF_SYM_KEY2", from: "2024-01-01", to: "2024-06-01", exchange: "NSE" }),
    ]);

    expect(fetchCallCount).toBe(2);
  });
});

describe("runLatestCandleRefreshOnce single-flight", () => {
  it("D. two simultaneous calls for the same exchange+symbol result in exactly one underlying sync execution", async () => {
    let fetchCallCount = 0;
    const gate = deferred<void>();
    const fetchLatestDailyCandles = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      await gate.promise;
      return [{ symbol: "RF_SYM_D", time: "2024-06-01", open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    });

    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchLatestDailyCandles,
    } as never);
    getOrCreateInstrument.mockResolvedValue({ id: "i-d", instrumentToken: "tok-d" } as never);

    const first = runLatestCandleRefreshOnce({ symbol: "RF_SYM_D", exchange: "NSE" });
    const second = runLatestCandleRefreshOnce({ symbol: "RF_SYM_D", exchange: "NSE" });

    expect(first).toBe(second);

    gate.resolve();
    await Promise.all([first, second]);

    expect(fetchCallCount).toBe(1);
  });

  it("E. different symbols run independently, each with its own execution", async () => {
    let fetchCallCount = 0;
    const fetchLatestDailyCandles = vi.fn().mockImplementation(async (input: { symbols: string[] }) => {
      fetchCallCount++;
      return input.symbols.map((symbol) => ({
        symbol,
        time: "2024-06-01",
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      }));
    });

    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchLatestDailyCandles,
    } as never);
    getOrCreateInstrument.mockResolvedValue({ id: "i-e", instrumentToken: "tok-e" } as never);

    await Promise.all([
      runLatestCandleRefreshOnce({ symbol: "RF_SYM_E1", exchange: "NSE" }),
      runLatestCandleRefreshOnce({ symbol: "RF_SYM_E2", exchange: "NSE" }),
    ]);

    expect(fetchCallCount).toBe(2);
  });
});

describe("syncLatestDailyCandlesForSymbols orchestration", () => {
  it("persists candles returned by the provider for a successful sync", async () => {
    const fetchLatestDailyCandles = vi.fn().mockResolvedValue([
      { symbol: "SYNC_OK", time: "2024-06-01", open: 100, high: 105, low: 99, close: 104, volume: 1000 },
    ]);
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchLatestDailyCandles,
    } as never);
    getOrCreateInstrument.mockResolvedValue({ id: "i-sync-ok", instrumentToken: "tok-sync-ok" } as never);

    const result = await syncLatestDailyCandlesForSymbols(["SYNC_OK"], "NSE");

    expect(result).toEqual({ insertedDaily: 1 });
    expect(fetchLatestDailyCandles).toHaveBeenCalledTimes(1);
  });

  it("returns zero inserted when no eligible provider adapter exists (no throw)", async () => {
    getEligibleProviderAdapter.mockResolvedValue(undefined as never);

    const result = await syncLatestDailyCandlesForSymbols(["SYNC_NOADAPTER"], "NSE");

    expect(result).toEqual({ insertedDaily: 0 });
  });

  it("propagates a provider fetch failure rather than silently swallowing it", async () => {
    const fetchLatestDailyCandles = vi.fn().mockRejectedValue(new Error("provider down"));
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchLatestDailyCandles,
    } as never);

    await expect(syncLatestDailyCandlesForSymbols(["SYNC_FAIL"], "NSE")).rejects.toThrow("provider down");
  });

  it("skips symbols still within their failure cooldown, without calling the provider for them", async () => {
    // A successful provider response that simply doesn't include this
    // symbol (e.g. it was delisted/unavailable) is what actually marks the
    // cooldown here - markLatestCandleSyncFailed runs on !syncedSymbols.has(symbol)
    // after a successful call, not on a thrown provider error (which exits
    // the function before that loop is ever reached).
    const fetchLatestDailyCandles = vi.fn().mockResolvedValue([]);
    getEligibleProviderAdapter.mockResolvedValue({
      providerKey: "eodhd",
      fetchLatestDailyCandles,
    } as never);

    await syncLatestDailyCandlesForSymbols(["SYNC_COOLDOWN"], "NSE");
    expect(fetchLatestDailyCandles).toHaveBeenCalledTimes(1);

    // A later, otherwise-independent request for the SAME still-failed
    // symbol is filtered out before ever reaching the provider again -
    // symbolsToSync becomes empty, so the adapter lookup short-circuits.
    fetchLatestDailyCandles.mockClear();
    const result = await syncLatestDailyCandlesForSymbols(["SYNC_COOLDOWN"], "NSE");
    expect(result).toEqual({ insertedDaily: 0 });
    expect(fetchLatestDailyCandles).not.toHaveBeenCalled();
  });
});

describe("backfillDailyCandles", () => {
  it("returns zero-insert result when no eligible provider adapter exists, without creating an instrument", async () => {
    getEligibleProviderAdapter.mockResolvedValue(undefined as never);

    const result = await backfillDailyCandles({
      symbol: "BF_NOADAPTER",
      from: "2024-01-01",
      to: "2024-06-01",
      exchange: "NSE",
    });

    expect(result).toEqual({ insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 });
    expect(getOrCreateInstrument).not.toHaveBeenCalled();
  });
});
