import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.hoisted(() => vi.fn());
const listProductionExchanges = vi.hoisted(() => vi.fn());
const getMarketDataQueue = vi.hoisted(() => vi.fn());
const addJobWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({ db: { select } }));
vi.mock("../market-data/market-data.universe", () => ({ listProductionExchanges }));
vi.mock("./queues", () => ({ getMarketDataQueue, addJobWithTimeout }));

import { isDailyScheduleRecoveryDue, recoverDueDailyCandleSchedules } from "./daily-candle-schedule-watchdog";

const getJob = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listProductionExchanges.mockResolvedValue(["BSE"]);
  getMarketDataQueue.mockReturnValue({ getJob });
  getJob.mockResolvedValue(null);
  addJobWithTimeout.mockResolvedValue(undefined);
  select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
});

describe("daily candle schedule watchdog", () => {
  it("waits 15 minutes and stops trying after the bounded recovery window", () => {
    const morning = new Date("2026-10-14T04:15:00.000Z");
    expect(isDailyScheduleRecoveryDue("daily_candle_morning", morning, new Date("2026-10-14T04:29:59.000Z"))).toBe(false);
    expect(isDailyScheduleRecoveryDue("daily_candle_morning", morning, new Date("2026-10-14T04:30:00.000Z"))).toBe(true);
    expect(isDailyScheduleRecoveryDue("daily_candle_morning", morning, new Date("2026-10-14T08:15:00.000Z"))).toBe(false);
  });

  it("enqueues one date-bound morning recovery when the scheduled run is absent", async () => {
    await recoverDueDailyCandleSchedules(new Date("2026-10-14T04:35:00.000Z"));

    expect(addJobWithTimeout).toHaveBeenCalledOnce();
    expect(addJobWithTimeout).toHaveBeenCalledWith(
      expect.any(Object),
      "daily-candle-sync",
      { exchange: "BSE", jobType: "daily_candle_morning", tradingDate: "2026-10-14", coverageTradingDate: "2026-10-13" },
      expect.objectContaining({ jobId: "daily-candle-schedule-recovery-BSE-daily_candle_morning-2026-10-14" }),
    );
  });

  it("leaves a waiting scheduled run alone", async () => {
    getJob.mockResolvedValueOnce({ getState: async () => "waiting" });

    await recoverDueDailyCandleSchedules(new Date("2026-10-14T04:35:00.000Z"));

    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });

  it("does not enqueue again while its recovery job is waiting", async () => {
    getJob.mockResolvedValueOnce(null).mockResolvedValueOnce({ getState: async () => "waiting" });

    await recoverDueDailyCandleSchedules(new Date("2026-10-14T04:35:00.000Z"));

    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });

  it("does not duplicate a completed ledger run", async () => {
    select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ status: "completed", bullmqJobId: null }] }) }) });

    await recoverDueDailyCandleSchedules(new Date("2026-10-14T04:35:00.000Z"));

    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });

  it("recovers the post-market run with that trading date, not the next day's date", async () => {
    await recoverDueDailyCandleSchedules(new Date("2026-10-14T11:05:00.000Z"));

    expect(addJobWithTimeout).toHaveBeenCalledOnce();
    expect(addJobWithTimeout.mock.calls[0][2]).toEqual({
      exchange: "BSE", jobType: "daily_candle_post_market", tradingDate: "2026-10-14", coverageTradingDate: "2026-10-14",
    });
  });

  it("does not schedule a recovery on the weekend", async () => {
    await recoverDueDailyCandleSchedules(new Date("2026-10-17T05:00:00.000Z"));

    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });
});
