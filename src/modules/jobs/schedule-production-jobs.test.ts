import { beforeEach, describe, expect, it, vi } from "vitest";

const listProductionExchanges = vi.hoisted(() => vi.fn());
const listInstrumentSyncExchanges = vi.hoisted(() => vi.fn());
const scheduleRepeatableMarketDataSync = vi.hoisted(() => vi.fn());
const scheduleRepeatableDailyCandleSync = vi.hoisted(() => vi.fn());
const scheduleCandleBootstrapReconciliation = vi.hoisted(() => vi.fn());
const reconcileWeeklyStrongBacktests = vi.hoisted(() => vi.fn());
const ensureExpectedMarketDataJobs = vi.hoisted(() => vi.fn());
const markExpectedMarketDataJobsQueued = vi.hoisted(() => vi.fn());

vi.mock("../market-data/market-data.universe", () => ({ listProductionExchanges, listInstrumentSyncExchanges }));
vi.mock("./queues", () => ({
  scheduleRepeatableMarketDataSync,
  scheduleRepeatableDailyCandleSync,
  scheduleCandleBootstrapReconciliation,
}));
vi.mock("../weekly-strong-backtest/weekly-strong-backtest.reconciliation", () => ({ reconcileWeeklyStrongBacktests }));
vi.mock("./market-data-job-ledger", () => ({ ensureExpectedMarketDataJobs, markExpectedMarketDataJobsQueued }));

import { scheduleProductionMarketDataJobs } from "./schedule-production-jobs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleProductionMarketDataJobs", () => {
  it("hands only the production universe to every scheduler - retired NSE never reaches them", async () => {
    listProductionExchanges.mockResolvedValue(["BSE", "BSE_IDX"]);
    listInstrumentSyncExchanges.mockResolvedValue(["BSE", "BSE_IDX"]);

    await scheduleProductionMarketDataJobs();

    expect(scheduleRepeatableMarketDataSync).toHaveBeenCalledWith(["BSE", "BSE_IDX"]);
    expect(scheduleRepeatableDailyCandleSync).toHaveBeenCalledWith(["BSE", "BSE_IDX"]);
    expect(scheduleCandleBootstrapReconciliation).toHaveBeenCalledWith(["BSE", "BSE_IDX"]);
    expect(reconcileWeeklyStrongBacktests).toHaveBeenCalledTimes(2);
    for (const call of [
      scheduleRepeatableMarketDataSync,
      scheduleRepeatableDailyCandleSync,
      scheduleCandleBootstrapReconciliation,
    ]) {
      expect(call.mock.calls[0][0]).not.toContain("NSE");
      expect(call.mock.calls[0][0]).not.toContain("US");
    }
  });

  it("registers no jobs (and prunes all leftovers) when no exchange is in the production universe", async () => {
    listProductionExchanges.mockResolvedValue([]);
    listInstrumentSyncExchanges.mockResolvedValue([]);

    await scheduleProductionMarketDataJobs();

    expect(scheduleRepeatableMarketDataSync).toHaveBeenCalledWith([]);
    expect(scheduleRepeatableDailyCandleSync).toHaveBeenCalledWith([]);
    expect(scheduleCandleBootstrapReconciliation).toHaveBeenCalledWith([]);
    expect(reconcileWeeklyStrongBacktests).not.toHaveBeenCalled();
  });

  it("uses a different exchange list for instrument discovery than for candle sync", async () => {
    listProductionExchanges.mockResolvedValue(["BSE"]);
    listInstrumentSyncExchanges.mockResolvedValue(["BSE", "BSE_IDX"]);

    await scheduleProductionMarketDataJobs();

    expect(scheduleRepeatableMarketDataSync).toHaveBeenCalledWith(["BSE", "BSE_IDX"]);
    expect(scheduleRepeatableDailyCandleSync).toHaveBeenCalledWith(["BSE"]);
  });

  it("never throws when the universe lookup fails", async () => {
    listProductionExchanges.mockRejectedValue(new Error("db down"));
    listInstrumentSyncExchanges.mockResolvedValue([]);

    await expect(scheduleProductionMarketDataJobs()).resolves.toBeUndefined();
    expect(scheduleRepeatableDailyCandleSync).not.toHaveBeenCalled();
  });
});
