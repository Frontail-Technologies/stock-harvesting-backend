import { beforeEach, describe, expect, it, vi } from "vitest";

// Data safety: replaceCandlesAtomically deletes the requested range before inserting the
// provider result, so an empty (or failed) provider result must never reach that delete.
// Uses the REAL backfillDailyCandles / refreshDailyCandles / replaceCandlesAtomically against a
// transaction-modelling fake DB. The fake's delete removes every row, which is enough to prove
// "deleted" versus "untouched".

const noHistory = vi.hoisted(() => ({
  readNoHistoryConfirmedAt: vi.fn(),
  recordNoHistoryConfirmed: vi.fn(),
  clearNoHistory: vi.fn(),
}));

vi.mock("../../db/client", () => ({ db: {} }));
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
vi.mock("./market-data.candles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market-data.candles")>();
  return { ...actual, readCandleHistoryRange: vi.fn(), readCandleDatesInRange: vi.fn() };
});
vi.mock("./trading-calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./trading-calendar")>();
  return { ...actual, getLatestExpectedTradingDay: vi.fn() };
});
vi.mock("./dashboard-snapshot-store", () => ({ deleteDashboardSnapshots: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./market-data.no-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market-data.no-history")>();
  return { ...actual, ...noHistory };
});

import type { DbOrTx } from "../../db/client";
import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentSyncModule from "./market-data.instrument-sync";
import * as candlesModule from "./market-data.candles";
import * as tradingCalendarModule from "./trading-calendar";
import { backfillDailyCandles, refreshDailyCandles } from "./market-data.candle-sync";

type FakeRow = { exchange: string; symbol: string; timeframe: string; time: string; close: string };

function createFakeDb(seedRows: FakeRow[], options: { failTimeframe?: string } = {}) {
  let committed = [...seedRows];
  let transactionCount = 0;

  const makeTx = (pending: FakeRow[]) => ({
    delete: () => ({
      where: async () => {
        pending.length = 0;
      },
    }),
    insert: () => ({
      values: (rows: FakeRow[]) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            for (const row of rows) {
              if (options.failTimeframe && row.timeframe === options.failTimeframe) {
                throw new Error(`simulated upsert failure for ${options.failTimeframe}`);
              }
              const index = pending.findIndex(
                (existing) => existing.symbol === row.symbol && existing.timeframe === row.timeframe && existing.time === row.time
              );
              if (index >= 0) pending[index] = row;
              else pending.push(row);
            }
            return rows.map(() => ({ wasInsert: true }));
          },
        }),
      }),
    }),
  });

  const db = {
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      transactionCount += 1;
      const pending = [...committed];
      await callback(makeTx(pending));
      committed = pending;
    },
  };

  return { db: db as unknown as DbOrTx, getCommitted: () => committed, getTransactionCount: () => transactionCount };
}

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const getOrCreateInstrument = vi.mocked(instrumentSyncModule.getOrCreateInstrument);
const readCandleHistoryRange = vi.mocked(candlesModule.readCandleHistoryRange);
const readCandleDatesInRange = vi.mocked(candlesModule.readCandleDatesInRange);
const getLatestExpectedTradingDay = vi.mocked(tradingCalendarModule.getLatestExpectedTradingDay);

const existing: FakeRow[] = [
  { exchange: "BSE", symbol: "TCS", timeframe: "1D", time: "2026-09-16", close: "100.0000" },
  { exchange: "BSE", symbol: "TCS", timeframe: "1D", time: "2026-09-17", close: "101.0000" },
  { exchange: "BSE", symbol: "TCS", timeframe: "1W", time: "2026-09-14", close: "101.0000" },
];
const RANGE = { symbol: "TCS", exchange: "BSE", from: "2026-09-12", to: "2026-09-18" };
const candle = (time: string, close = 105) => ({ time, open: close, high: close, low: close, close, volume: 10 });

function useAdapter(fetchDailyCandles: ReturnType<typeof vi.fn>) {
  getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchDailyCandles } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  getLatestExpectedTradingDay.mockReturnValue("2026-09-18");
  getOrCreateInstrument.mockResolvedValue({ id: "instrument-1", instrumentToken: "TCS" } as never);
  noHistory.readNoHistoryConfirmedAt.mockResolvedValue(null);
  noHistory.recordNoHistoryConfirmed.mockResolvedValue(undefined);
  noHistory.clearNoHistory.mockResolvedValue(undefined);
});

describe("existing candles are never deleted by an empty or failed provider result", () => {
  it("successful EMPTY incremental response: every existing candle is preserved and no delete transaction runs", async () => {
    const fake = createFakeDb(existing);
    useAdapter(vi.fn().mockResolvedValue([]));

    const result = await backfillDailyCandles(RANGE, fake.db);

    expect(result.dailyCandles).toEqual([]);
    expect(result.providerConfirmedEmpty).toBe(true);
    expect(fake.getTransactionCount()).toBe(0);
    expect(fake.getCommitted()).toEqual(existing);
  });

  it("provider TIMEOUT: existing candles untouched", async () => {
    const fake = createFakeDb(existing);
    useAdapter(vi.fn().mockRejectedValue(new Error("Global Datafeeds request timed out: GetHistory")));

    await expect(backfillDailyCandles(RANGE, fake.db)).rejects.toThrow("timed out");

    expect(fake.getTransactionCount()).toBe(0);
    expect(fake.getCommitted()).toEqual(existing);
  });

  it("provider ERROR: existing candles untouched", async () => {
    const fake = createFakeDb(existing);
    useAdapter(vi.fn().mockRejectedValue(new Error("Global Datafeeds returned an error")));

    await expect(backfillDailyCandles(RANGE, fake.db)).rejects.toThrow("returned an error");

    expect(fake.getTransactionCount()).toBe(0);
    expect(fake.getCommitted()).toEqual(existing);
  });

  it("persistence failure partway through a non-empty replacement rolls back: existing candles untouched", async () => {
    const fake = createFakeDb(existing, { failTimeframe: "1W" });
    useAdapter(vi.fn().mockResolvedValue([candle("2026-09-17"), candle("2026-09-18")]));

    await expect(backfillDailyCandles(RANGE, fake.db)).rejects.toThrow("simulated upsert failure");

    expect(fake.getCommitted()).toEqual(existing);
  });

  it("refreshDailyCandles on an incremental window that comes back empty leaves stored history alone", async () => {
    const fake = createFakeDb(existing);
    readCandleHistoryRange.mockResolvedValue({ from: "2020-01-01", to: "2026-09-17" });
    readCandleDatesInRange.mockResolvedValue(new Set(["2026-09-16", "2026-09-17"]));
    useAdapter(vi.fn().mockResolvedValue([]));

    const result = await refreshDailyCandles({ symbol: "TCS", exchange: "BSE" }, fake.db);

    expect(result.status).toBe("provider-empty");
    expect(fake.getCommitted()).toEqual(existing);
    // has stored candles -> not a bootstrap, so no no-history conclusion is drawn
    expect(noHistory.recordNoHistoryConfirmed).not.toHaveBeenCalled();
  });
});

describe("non-empty replacement is unchanged", () => {
  it("replaces the requested range atomically: old rows in the range are replaced by the provider candles at all three timeframes", async () => {
    const fake = createFakeDb(existing);
    useAdapter(vi.fn().mockResolvedValue([candle("2026-09-17", 110), candle("2026-09-18", 111)]));

    const result = await backfillDailyCandles(RANGE, fake.db);

    expect(result.dailyCandles).toHaveLength(2);
    expect(result.providerConfirmedEmpty).toBe(false);
    expect(fake.getTransactionCount()).toBe(1);
    const committed = fake.getCommitted();
    expect(committed.filter((row) => row.timeframe === "1D").map((row) => row.time).sort()).toEqual(["2026-09-17", "2026-09-18"]);
    expect(committed.some((row) => row.time === "2026-09-16")).toBe(false); // replaced by the provider result, as before
    expect(committed.some((row) => row.timeframe === "1W")).toBe(true);
    expect(committed.some((row) => row.timeframe === "1M")).toBe(true);
  });
});

describe("zero-history instrument still follows the no-history behavior", () => {
  it("no stored candles + successful empty full-range response: nothing is written, and the no-history state is recorded", async () => {
    const fake = createFakeDb([]);
    readCandleHistoryRange.mockResolvedValue(null as never);
    readCandleDatesInRange.mockResolvedValue(new Set());
    useAdapter(vi.fn().mockResolvedValue([]));

    const result = await refreshDailyCandles({ symbol: "1000EQ", exchange: "BSE_IDX" }, fake.db);

    expect(result.status).toBe("provider-empty");
    expect(fake.getTransactionCount()).toBe(0);
    expect(fake.getCommitted()).toEqual([]);
    expect(noHistory.recordNoHistoryConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ exchange: "BSE_IDX", symbol: "1000EQ" })
    );
  });
});
