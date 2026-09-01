import { afterEach, describe, expect, it } from "vitest";

import { env } from "../../shared/env";
import { getRedisConnectionOptions } from "./queues";

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
