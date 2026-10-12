import { beforeEach, describe, expect, it, vi } from "vitest";

const queueApi = vi.hoisted(() => ({
  add: vi.fn(),
  upsertJobScheduler: vi.fn(),
  getJobSchedulers: vi.fn(),
  removeJobScheduler: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = queueApi.add;
    upsertJobScheduler = queueApi.upsertJobScheduler;
    getJobSchedulers = queueApi.getJobSchedulers;
    removeJobScheduler = queueApi.removeJobScheduler;
    getRepeatableJobs = queueApi.getRepeatableJobs;
    removeRepeatableByKey = queueApi.removeRepeatableByKey;
    on = vi.fn();
  },
  QueueEvents: class {
    on = vi.fn();
  },
}));

import { env } from "../../shared/env";
import { scheduleRepeatableDailyCandleSync, scheduleRepeatableMarketDataSync } from "./queues";

beforeEach(() => {
  vi.clearAllMocks();
  env.REDIS_URL = "redis://localhost:6379";
  queueApi.add.mockResolvedValue(undefined);
  queueApi.upsertJobScheduler.mockResolvedValue(undefined);
  queueApi.removeJobScheduler.mockResolvedValue(true);
  queueApi.getRepeatableJobs.mockResolvedValue([]);
  queueApi.removeRepeatableByKey.mockResolvedValue(true);
});

describe("repeatable scheduler registration", () => {
  it("registers daily sync schedulers only for the exchanges it is given", async () => {
    queueApi.getJobSchedulers.mockResolvedValue([]);

    await scheduleRepeatableDailyCandleSync(["BSE"]);

    const jobIds = queueApi.upsertJobScheduler.mock.calls.map((call) => call[0] as string);
    expect(jobIds.length).toBeGreaterThan(0);
    expect(jobIds.every((id) => id.startsWith("repeatable-daily-candle-sync-BSE-"))).toBe(true);
  });

  it("can defer newly registered schedules until the next operating day", async () => {
    queueApi.getJobSchedulers.mockResolvedValue([]);
    const startDate = new Date("2026-09-29T18:30:00.000Z");

    await scheduleRepeatableDailyCandleSync(["BSE"], { startDate });

    expect(queueApi.upsertJobScheduler).toHaveBeenCalledWith(
      "repeatable-daily-candle-sync-BSE-morning",
      expect.objectContaining({ startDate }),
      expect.objectContaining({ name: "daily-candle-sync" }),
    );
  });

  it("removes legacy repeats without removing the stable daily schedulers", async () => {
    queueApi.getJobSchedulers.mockResolvedValue([]);
    queueApi.getRepeatableJobs.mockResolvedValue([
      { name: "daily-candle-sync", key: "legacy-hash-1" },
      { name: "daily-candle-sync", key: "legacy-hash-2" },
      { name: "daily-candle-sync", key: "repeatable-daily-candle-sync-BSE-morning" },
      { name: "instrument-sync", key: "other-hash" },
    ]);

    await scheduleRepeatableDailyCandleSync(["BSE"]);

    expect(queueApi.removeRepeatableByKey.mock.calls.map((call) => call[0])).toEqual([
      "legacy-hash-1",
      "legacy-hash-2",
    ]);
    expect(queueApi.upsertJobScheduler).toHaveBeenCalledTimes(2);
  });

  it("removes schedulers left behind for an exchange that is no longer in the universe", async () => {
    queueApi.getJobSchedulers.mockResolvedValue([
      { id: "repeatable-daily-candle-sync-BSE-morning" },
      { id: "repeatable-daily-candle-sync-BSE-retry" },
      { id: "repeatable-daily-candle-sync-NSE-morning" },
      { id: "repeatable-daily-candle-sync-US-retry" },
      { id: "some-other-scheduler" },
    ]);

    await scheduleRepeatableDailyCandleSync(["BSE"]);

    const removed = queueApi.removeJobScheduler.mock.calls.map((call) => call[0]);
    expect(removed).toEqual([
      "repeatable-daily-candle-sync-BSE-retry",
      "repeatable-daily-candle-sync-NSE-morning",
      "repeatable-daily-candle-sync-US-retry",
    ]);
  });

  it("prunes instrument-sync schedulers the same way and never touches unrelated ones", async () => {
    queueApi.getJobSchedulers.mockResolvedValue([
      { id: "repeatable-instrument-sync-BSE" },
      { id: "repeatable-instrument-sync-NSE" },
      { id: "repeatable-candle-bootstrap-reconcile-NSE" },
    ]);

    await scheduleRepeatableMarketDataSync(["BSE"]);

    expect(queueApi.removeJobScheduler.mock.calls.map((call) => call[0])).toEqual([
      "repeatable-instrument-sync-NSE",
    ]);
  });

  it("syncs instrument masters once per week without running price refreshes", async () => {
    queueApi.getJobSchedulers.mockResolvedValue([]);

    await scheduleRepeatableMarketDataSync(["BSE", "BSE_IDX"]);

    expect(queueApi.upsertJobScheduler).toHaveBeenNthCalledWith(
      1,
      "repeatable-instrument-sync-BSE",
      { pattern: "30 18 * * 5", tz: "Asia/Kolkata" },
      expect.objectContaining({
        name: "instrument-sync",
        data: { exchange: "BSE" },
      }),
    );
    expect(queueApi.upsertJobScheduler).toHaveBeenNthCalledWith(
      2,
      "repeatable-instrument-sync-BSE_IDX",
      { pattern: "30 18 * * 5", tz: "Asia/Kolkata" },
      expect.objectContaining({
        name: "instrument-sync",
        data: { exchange: "BSE_IDX" },
      }),
    );
  });
});
