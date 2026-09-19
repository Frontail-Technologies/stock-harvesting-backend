import { beforeEach, describe, expect, it, vi } from "vitest";

const getMarketDataQueue = vi.hoisted(() => vi.fn());
vi.mock("./queues", () => ({ getMarketDataQueue }));

import { getMarketDataQueueSnapshot, toQueueSnapshotJob } from "./queue-snapshot.service";

const NOW = Date.parse("2026-09-19T18:00:00.000Z");

beforeEach(() => vi.clearAllMocks());

describe("toQueueSnapshotJob", () => {
  it("maps an active job with its start time and exchange", () => {
    expect(
      toQueueSnapshotJob(
        { id: "repeat:abc:1", name: "instrument-sync", data: { exchange: "BSE" }, attemptsMade: 1, timestamp: NOW, processedOn: NOW + 5_000 },
        "active",
      ),
    ).toEqual({
      id: "repeat:abc:1",
      name: "instrument-sync",
      state: "active",
      exchange: "BSE",
      attemptsMade: 1,
      addedAt: new Date(NOW).toISOString(),
      startedAt: new Date(NOW + 5_000).toISOString(),
      runAt: null,
    });
  });

  it("computes when a delayed job will run", () => {
    const job = toQueueSnapshotJob({ id: "j", name: "daily-candle-sync", timestamp: NOW, delay: 60_000 }, "delayed");
    expect(job.runAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(job.startedAt).toBeNull();
  });

  it("tolerates missing data, ids and timestamps", () => {
    expect(toQueueSnapshotJob({ name: "x" }, "waiting")).toMatchObject({ id: "", exchange: null, addedAt: null, attemptsMade: 0 });
  });
});

describe("getMarketDataQueueSnapshot", () => {
  it("reports unavailable when Redis is not configured", async () => {
    getMarketDataQueue.mockReturnValue(null);

    await expect(getMarketDataQueueSnapshot()).resolves.toEqual({
      available: false,
      counts: { active: 0, waiting: 0, delayed: 0 },
      jobs: [],
    });
  });

  it("returns counts and jobs grouped active, waiting, delayed", async () => {
    const getJobs = vi.fn(async ([state]: string[]) => ({
      active: [{ id: "a1", name: "instrument-sync", timestamp: NOW }],
      waiting: [{ id: "w1", name: "market-data-catch-up", data: { exchange: "BSE" }, timestamp: NOW }],
      delayed: [{ id: "d1", name: "daily-candle-sync", timestamp: NOW, delay: 1_000 }],
    })[state as "active" | "waiting" | "delayed"]);
    getMarketDataQueue.mockReturnValue({ getJobCounts: async () => ({ active: 1, waiting: 5, delayed: 10 }), getJobs });

    const snapshot = await getMarketDataQueueSnapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.counts).toEqual({ active: 1, waiting: 5, delayed: 10 });
    expect(snapshot.jobs.map((job) => [job.state, job.name])).toEqual([
      ["active", "instrument-sync"],
      ["waiting", "market-data-catch-up"],
      ["delayed", "daily-candle-sync"],
    ]);
  });

  it("degrades to unavailable, not an error, when Redis cannot be read", async () => {
    getMarketDataQueue.mockReturnValue({
      getJobCounts: async () => {
        throw new Error("Connection is closed");
      },
      getJobs: async () => [],
    });

    await expect(getMarketDataQueueSnapshot()).resolves.toMatchObject({ available: false, jobs: [] });
  });
});
