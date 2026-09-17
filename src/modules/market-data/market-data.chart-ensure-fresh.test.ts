import { beforeEach, describe, expect, it, vi } from "vitest";

// On-demand chart self-heal (Phase 4B). Reuses refreshDailyCandles
// (Phase 4A) as the sole repair implementation and dedupes provider work
// per instrument + latest-expected-trading-date via a BullMQ job id (no
// ":" characters - BullMQ job ids are used as Redis key segments), so
// concurrent chart opens for the same symbol collapse into one job. A
// newly queued/active job is awaited up to a bounded timeout so a fast
// repair returns its real terminal status instead of a stale "in-progress".

vi.mock("./market-data.candle-sync", () => ({
  refreshDailyCandles: vi.fn(),
}));

vi.mock("../jobs/queues", () => ({
  getMarketDataQueue: vi.fn(),
  getMarketDataQueueEvents: vi.fn(),
}));

vi.mock("./trading-calendar", () => ({
  getLatestExpectedTradingDay: vi.fn(),
}));

import * as candleSyncModule from "./market-data.candle-sync";
import * as queuesModule from "../jobs/queues";
import * as tradingCalendarModule from "./trading-calendar";
import { ensureFreshDailyCandles } from "./market-data.chart-ensure-fresh";

const refreshDailyCandles = vi.mocked(candleSyncModule.refreshDailyCandles);
const getMarketDataQueue = vi.mocked(queuesModule.getMarketDataQueue);
const getMarketDataQueueEvents = vi.mocked(queuesModule.getMarketDataQueueEvents);
const getLatestExpectedTradingDay = vi.mocked(tradingCalendarModule.getLatestExpectedTradingDay);

function fakeQueue() {
  return {
    getJob: vi.fn(),
    add: vi.fn(),
  };
}

function fakeJob(state: string, waitUntilFinished: ReturnType<typeof vi.fn>, returnvalue?: unknown) {
  return {
    getState: vi.fn().mockResolvedValue(state),
    returnvalue,
    remove: vi.fn().mockResolvedValue(undefined),
    waitUntilFinished,
  };
}

function resolvedWait(value: unknown) {
  return vi.fn().mockResolvedValue(value);
}

function timedOutWait() {
  return vi.fn().mockRejectedValue(new Error("Job wait x timed out before finishing, no finish notification arrived after 12000ms (id=y)"));
}

function failedWait(reason: string) {
  return vi.fn().mockRejectedValue(new Error(reason));
}

beforeEach(() => {
  vi.clearAllMocks();
  getLatestExpectedTradingDay.mockReturnValue("2026-09-11");
  getMarketDataQueueEvents.mockReturnValue({} as never);
});

describe("ensureFreshDailyCandles - job id safety", () => {
  it("the dedupe job id contains no ':' characters", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    const [, , opts] = queue.add.mock.calls[0];
    expect(opts.jobId).toBe("chart-ensure-fresh-BSE-TCS-2026-09-11");
    expect(opts.jobId).not.toContain(":");
  });
});

describe("ensureFreshDailyCandles - queue-backed dedupe", () => {
  it("enqueues exactly one job on the first ensure-fresh call for a symbol/expected-date", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, data] = queue.add.mock.calls[0];
    expect(jobName).toBe("chart-candle-ensure-fresh");
    expect(data).toEqual({ symbol: "TCS", exchange: "BSE" });
    expect(result).toEqual({ status: "in-progress", changed: false, latestExpectedDate: "2026-09-11" });
    expect(refreshDailyCandles).not.toHaveBeenCalled();
  });

  it("a newly queued job completing within the bounded wait returns the real repaired result", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(
      fakeJob("waiting", resolvedWait({ symbol: "TCS", status: "repaired", insertedDaily: 6, failedDates: [] }))
    );
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(result).toEqual({ status: "repaired", changed: true, latestExpectedDate: "2026-09-11" });
  });

  it("a newly queued job completing with 'updated' also returns changed:true", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(
      fakeJob("waiting", resolvedWait({ symbol: "RELIANCE", status: "updated", insertedDaily: 5, failedDates: [] }))
    );
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "RELIANCE", exchange: "BSE" });

    expect(result).toEqual({ status: "updated", changed: true, latestExpectedDate: "2026-09-11" });
  });

  it("a job exceeding the bounded wait returns in-progress cleanly, not an error", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(fakeJob("active", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "SLOWSYMBOL", exchange: "BSE" });

    expect(result).toEqual({ status: "in-progress", changed: false, latestExpectedDate: "2026-09-11" });
  });

  it("a repaired/updated symbol with a completed job returns its status without enqueueing again", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(
      fakeJob("completed", resolvedWait(undefined), { symbol: "TCS", status: "repaired", insertedDaily: 7, failedDates: [] })
    );
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(result).toEqual({ status: "repaired", changed: true, latestExpectedDate: "2026-09-11" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("an already-current completed job returns quickly with changed:false and zero additional provider work", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(
      fakeJob("completed", resolvedWait(undefined), {
        symbol: "RELIANCE",
        status: "already-current",
        insertedDaily: 0,
        failedDates: [],
      })
    );
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "RELIANCE", exchange: "BSE" });

    expect(result).toEqual({ status: "already-current", changed: false, latestExpectedDate: "2026-09-11" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("an existing active/waiting job is reused (not re-enqueued) - two calls collapse into one job", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValueOnce(undefined).mockResolvedValueOnce(fakeJob("waiting", timedOutWait()));
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    const first = await ensureFreshDailyCandles({ symbol: "RELIANCE", exchange: "BSE" });
    const second = await ensureFreshDailyCandles({ symbol: "RELIANCE", exchange: "BSE" });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("in-progress");
    expect(second.status).toBe("in-progress");
  });

  it("two different symbols get independent jobs", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });
    await ensureFreshDailyCandles({ symbol: "LALPATHLAB", exchange: "BSE" });

    expect(queue.add).toHaveBeenCalledTimes(2);
    const jobIds = queue.add.mock.calls.map((call) => call[2].jobId);
    expect(new Set(jobIds).size).toBe(2);
  });

  it("a completed job whose repair failed is removed and retried, not permanently marked successful", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(
      fakeJob("completed", resolvedWait(undefined), {
        symbol: "TCS",
        status: "failed",
        insertedDaily: 0,
        failedDates: ["2026-09-11"],
      })
    );
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(result.status).toBe("in-progress");
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("a job that failed outright (threw) is removed and a fresh attempt is enqueued", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(fakeJob("failed", resolvedWait(undefined)));
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(result.status).toBe("in-progress");
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("a newly enqueued job that fails within the bounded wait is reported as failed, not cached as successful", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(fakeJob("active", failedWait("provider timeout")));
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });

    expect(result).toEqual({ status: "failed", changed: false, latestExpectedDate: "2026-09-11" });
  });

  it("removes a legacy bootstrap-required job and enqueues the now-supported bootstrap", async () => {
    const queue = fakeQueue();
    const legacyJob = fakeJob("completed", resolvedWait(undefined), {
        symbol: "NEWSYMBOL",
        status: "bootstrap-required",
        insertedDaily: 0,
        failedDates: [],
      });
    queue.getJob.mockResolvedValue(legacyJob);
    queue.add.mockResolvedValue(
      fakeJob("waiting", resolvedWait({
        symbol: "NEWSYMBOL",
        status: "updated",
        insertedDaily: 32,
        failedDates: [],
      }))
    );
    getMarketDataQueue.mockReturnValue(queue as never);

    const result = await ensureFreshDailyCandles({ symbol: "NEWSYMBOL", exchange: "BSE" });

    expect(legacyJob.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "updated", changed: true, latestExpectedDate: "2026-09-11" });
  });

  it("the expected trading date advancing changes the job key, making the symbol eligible again", async () => {
    const queue = fakeQueue();
    queue.getJob.mockResolvedValue(
      fakeJob("completed", resolvedWait(undefined), {
        symbol: "TCS",
        status: "already-current",
        insertedDaily: 0,
        failedDates: [],
      })
    );
    getMarketDataQueue.mockReturnValue(queue as never);

    getLatestExpectedTradingDay.mockReturnValueOnce("2026-09-11");
    await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });
    expect(queue.getJob).toHaveBeenLastCalledWith("chart-ensure-fresh-BSE-TCS-2026-09-11");

    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockResolvedValue(fakeJob("waiting", timedOutWait()));
    getLatestExpectedTradingDay.mockReturnValueOnce("2026-09-14");
    await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });
    expect(queue.getJob).toHaveBeenLastCalledWith("chart-ensure-fresh-BSE-TCS-2026-09-14");
  });
});

describe("ensureFreshDailyCandles - queue configured but unreachable", () => {
  it("falls back to the inline check instead of hanging or throwing when Redis is unreachable", async () => {
    const queue = fakeQueue();
    queue.getJob.mockRejectedValue(new Error("connect ECONNREFUSED"));
    getMarketDataQueue.mockReturnValue(queue as never);
    refreshDailyCandles.mockResolvedValue({
      symbol: "REDISDOWN",
      status: "already-current",
      insertedDaily: 0,
      failedDates: [],
    } as never);

    const result = await ensureFreshDailyCandles({ symbol: "REDISDOWN", exchange: "BSE" });

    expect(result.status).toBe("already-current");
    expect(refreshDailyCandles).toHaveBeenCalledTimes(1);
  });
});

describe("ensureFreshDailyCandles - real repair errors are never swallowed as in-progress", () => {
  it("a thrown provider/DB error surfaces as failed (not in-progress) and is not cached", async () => {
    getMarketDataQueue.mockReturnValue(null);
    refreshDailyCandles
      .mockRejectedValueOnce(new Error("Function not enabled"))
      .mockResolvedValueOnce({
        symbol: "BHARTIARTL",
        status: "updated",
        insertedDaily: 4,
        failedDates: [],
      } as never);

    const first = await ensureFreshDailyCandles({ symbol: "BHARTIARTL", exchange: "BSE" });
    const second = await ensureFreshDailyCandles({ symbol: "BHARTIARTL", exchange: "BSE" });

    expect(first).toEqual({ status: "failed", changed: false, latestExpectedDate: "2026-09-11" });
    expect(second.status).toBe("updated");
    expect(refreshDailyCandles).toHaveBeenCalledTimes(2);
  });

  it("a thrown error while Redis is unreachable also surfaces as failed, not in-progress", async () => {
    const queue = fakeQueue();
    queue.getJob.mockRejectedValue(new Error("connect ECONNREFUSED"));
    getMarketDataQueue.mockReturnValue(queue as never);
    refreshDailyCandles.mockRejectedValue(new Error("Function not enabled"));

    const result = await ensureFreshDailyCandles({ symbol: "BROKENSYMBOL", exchange: "BSE" });

    expect(result).toEqual({ status: "failed", changed: false, latestExpectedDate: "2026-09-11" });
  });
});

describe("ensureFreshDailyCandles - no-queue fallback (single instance/dev)", () => {
  it("reuses one refreshDailyCandles call across concurrent requests and caches the successful result", async () => {
    getMarketDataQueue.mockReturnValue(null);
    let resolveRefresh!: (value: unknown) => void;
    refreshDailyCandles.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }) as never
    );

    const first = ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });
    const second = ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });
    resolveRefresh({ symbol: "TCS", status: "updated", insertedDaily: 3, failedDates: [] });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(refreshDailyCandles).toHaveBeenCalledTimes(1);
    expect(firstResult.status).toBe("updated");
    expect(secondResult.status).toBe("updated");

    const third = await ensureFreshDailyCandles({ symbol: "TCS", exchange: "BSE" });
    expect(refreshDailyCandles).toHaveBeenCalledTimes(1);
    expect(third.status).toBe("updated");
  });

  it("does not cache a failed result - a later call retries", async () => {
    getMarketDataQueue.mockReturnValue(null);
    refreshDailyCandles.mockResolvedValueOnce({
      symbol: "LOSSYFALLBACK",
      status: "failed",
      insertedDaily: 0,
      failedDates: ["2026-09-11"],
    } as never);
    refreshDailyCandles.mockResolvedValueOnce({
      symbol: "LOSSYFALLBACK",
      status: "repaired",
      insertedDaily: 1,
      failedDates: [],
    } as never);

    const first = await ensureFreshDailyCandles({ symbol: "LOSSYFALLBACK", exchange: "BSE" });
    const second = await ensureFreshDailyCandles({ symbol: "LOSSYFALLBACK", exchange: "BSE" });

    expect(first.status).toBe("failed");
    expect(second.status).toBe("repaired");
    expect(refreshDailyCandles).toHaveBeenCalledTimes(2);
  });
});
