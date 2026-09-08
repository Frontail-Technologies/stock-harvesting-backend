import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";

import { env } from "../../shared/env";
import { addJobWithTimeout, getProducerRedisConnectionOptions, getRedisConnectionOptions } from "./queues";

// getMarketDataQueue()/scheduleRepeatableMarketDataSync() themselves aren't
// tested here: constructing a real bullmq Queue (even with a fake host)
// risks a live network/connection attempt in the test process, which this
// suite avoids everywhere else too. What's covered instead is the actual
// gate both getMarketDataQueue() and worker.ts's own startup check
// (`if (!connection) { ...exit(0) }`) are built on -
// getRedisConnectionOptions() is a pure function of env.REDIS_URL, and it's
// the single place "is Redis configured at all" gets decided.
//
// The queue-vs-inline branching itself (admin.service.ts's trigger
// functions, `if (queue) { queue.add(...) } else { run inline }`) was
// verified by direct code reading rather than a new test here, since
// exercising it end-to-end would mean either constructing a real Queue
// (see above) or adding a dependency-injection seam to admin.service.ts,
// which this phase's scope explicitly excludes (no admin trigger function
// changes). Confirmed structurally: triggerInstrumentSync, triggerPriceRefresh,
// triggerWeeklyStrongBacktestBackfill, and triggerWeeklyStrongBacktestHistoricalRebuild
// all branch on getMarketDataQueue() and have a real inline execution
// branch; triggerSectorClassificationSync and triggerIndexCandleBackfill
// never check the queue at all (always inline, by design - no registered
// worker handler for either); scheduleRepeatableMarketDataSync and
// syncWeeklyStrongBacktestIncremental have no inline fallback at all
// (schedule/queue-only, matching docs/ARCHITECTURE.md).
describe("getRedisConnectionOptions", () => {
  const originalRedisUrl = env.REDIS_URL;

  afterEach(() => {
    env.REDIS_URL = originalRedisUrl;
  });

  it("returns null when REDIS_URL is not configured", () => {
    env.REDIS_URL = undefined;
    expect(getRedisConnectionOptions()).toBeNull();
  });

  it("parses host, port, username, and password from a full REDIS_URL", () => {
    env.REDIS_URL = "redis://myuser:mypassword@redis.example.com:6380";
    const result = getRedisConnectionOptions();

    expect(result).toEqual({
      host: "redis.example.com",
      port: 6380,
      username: "myuser",
      password: "mypassword",
      maxRetriesPerRequest: null,
    });
  });

  it("defaults the port to 6379 when the URL doesn't specify one", () => {
    env.REDIS_URL = "redis://redis.example.com";
    const result = getRedisConnectionOptions();

    expect(result?.port).toBe(6379);
  });

  it("leaves username/password undefined when the URL has none", () => {
    env.REDIS_URL = "redis://redis.example.com:6379";
    const result = getRedisConnectionOptions();

    expect(result?.username).toBeUndefined();
    expect(result?.password).toBeUndefined();
  });
});

// Worker Redis connections require maxRetriesPerRequest: null for BullMQ's blocking commands
// (BRPOPLPUSH/BLMOVE) - the producer (this API process, enqueue-only) must NOT share that, so a
// down Redis fails a command deterministically instead of retrying it forever.
describe("getProducerRedisConnectionOptions", () => {
  const originalRedisUrl = env.REDIS_URL;

  afterEach(() => {
    env.REDIS_URL = originalRedisUrl;
  });

  it("returns null when REDIS_URL is not configured, same as the worker's own options", () => {
    env.REDIS_URL = undefined;
    expect(getProducerRedisConnectionOptions()).toBeNull();
  });

  it("parses the same host/port/username/password as the worker's connection options", () => {
    env.REDIS_URL = "redis://myuser:mypassword@redis.example.com:6380";
    const worker = getRedisConnectionOptions();
    const producer = getProducerRedisConnectionOptions();

    expect(producer).toMatchObject({
      host: worker?.host,
      port: worker?.port,
      username: worker?.username,
      password: worker?.password,
    });
  });

  it("uses a finite maxRetriesPerRequest, unlike the worker's required null", () => {
    env.REDIS_URL = "redis://redis.example.com:6379";
    const worker = getRedisConnectionOptions();
    const producer = getProducerRedisConnectionOptions();

    expect(worker?.maxRetriesPerRequest).toBeNull();
    expect(producer?.maxRetriesPerRequest).not.toBeNull();
    expect(typeof producer?.maxRetriesPerRequest).toBe("number");
  });

  it("disables the offline command queue and bounds the connect timeout", () => {
    env.REDIS_URL = "redis://redis.example.com:6379";
    const producer = getProducerRedisConnectionOptions();

    expect(producer?.enableOfflineQueue).toBe(false);
    expect(producer?.connectTimeout).toBeGreaterThan(0);
  });
});

// Root cause regression (BSE 100 stuck on "Preparing"/"Generating" forever): queue.add() never
// settles while Redis is configured but unreachable (maxRetriesPerRequest: null retries the
// underlying command forever) - addJobWithTimeout bounds that call so callers can fall back
// instead of hanging, and the DB-persisted status they were about to leave stale never sticks.
describe("addJobWithTimeout", () => {
  it("resolves once queue.add() resolves, well before the timeout", async () => {
    const add = vi.fn().mockResolvedValue({ id: "job-1" });
    const queue = { add } as unknown as Queue;

    await expect(addJobWithTimeout(queue, "some-job", { a: 1 })).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledWith("some-job", { a: 1 }, { removeOnComplete: true, removeOnFail: true });
  });

  it("passes a deterministic jobId through when given one, so a duplicate trigger collapses into the existing job instead of running the same heavy work twice", async () => {
    const add = vi.fn().mockResolvedValue({ id: "job-1" });
    const queue = { add } as unknown as Queue;

    await addJobWithTimeout(queue, "some-job", { a: 1 }, { jobId: "some-job:col-1" });

    expect(add).toHaveBeenCalledWith(
      "some-job",
      { a: 1 },
      { removeOnComplete: true, removeOnFail: true, jobId: "some-job:col-1" }
    );
  });

  it("rejects with a clear error once the timeout elapses, even if queue.add() never settles", async () => {
    vi.useFakeTimers();
    try {
      const add = vi.fn(() => new Promise(() => {}));
      const queue = { add } as unknown as Queue;

      const result = addJobWithTimeout(queue, "some-job", { a: 1 });
      const assertion = expect(result).rejects.toThrow(/Timed out enqueueing "some-job"/);

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
