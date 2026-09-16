import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queues", () => ({ getMarketDataQueueRedisClient: vi.fn() }));
vi.mock("./worker-heartbeat", () => ({
  readWorkerHeartbeat: vi.fn(),
  WORKER_NAMES: { marketData: "market-data-worker" },
}));
vi.mock("./realtime-events", () => ({ publishRealtimeEvent: vi.fn() }));

import * as queuesModule from "./queues";
import * as heartbeatModule from "./worker-heartbeat";
import * as realtimeEventsModule from "./realtime-events";
import { getMarketDataWorkerStatuses, startWorkerStatusChangeMonitor } from "./worker-status.service";

const getMarketDataQueueRedisClient = vi.mocked(queuesModule.getMarketDataQueueRedisClient);
const readWorkerHeartbeat = vi.mocked(heartbeatModule.readWorkerHeartbeat);
const publishRealtimeEvent = vi.mocked(realtimeEventsModule.publishRealtimeEvent);

describe("getMarketDataWorkerStatuses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports offline when the queue Redis client cannot be resolved", async () => {
    getMarketDataQueueRedisClient.mockResolvedValue(null);

    const statuses = await getMarketDataWorkerStatuses();

    expect(statuses).toEqual([
      { name: "market-data-worker", status: "offline", lastHeartbeat: null, startedAt: null },
    ]);
  });
});

describe("startWorkerStatusChangeMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes worker:status once when the status first resolves online", async () => {
    getMarketDataQueueRedisClient.mockResolvedValue({} as never);
    readWorkerHeartbeat.mockResolvedValue({
      name: "market-data-worker",
      status: "online",
      lastHeartbeat: "2026-09-16T10:00:00.000Z",
      startedAt: "2026-09-16T09:00:00.000Z",
    });

    const stop = startWorkerStatusChangeMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(publishRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin",
        event: expect.objectContaining({ type: "worker:status", data: expect.objectContaining({ status: "online" }) }),
      })
    );

    stop();
  });

  it("does not publish again while the status stays the same across polls", async () => {
    getMarketDataQueueRedisClient.mockResolvedValue({} as never);
    readWorkerHeartbeat.mockResolvedValue({
      name: "market-data-worker",
      status: "online",
      lastHeartbeat: "2026-09-16T10:00:00.000Z",
      startedAt: "2026-09-16T09:00:00.000Z",
    });

    const stop = startWorkerStatusChangeMonitor();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(publishRealtimeEvent).toHaveBeenCalledTimes(1);
    stop();
  });

  it("publishes again when the status transitions online -> offline", async () => {
    getMarketDataQueueRedisClient.mockResolvedValue({} as never);
    readWorkerHeartbeat.mockResolvedValue({
      name: "market-data-worker",
      status: "online",
      lastHeartbeat: "2026-09-16T10:00:00.000Z",
      startedAt: "2026-09-16T09:00:00.000Z",
    });

    const stop = startWorkerStatusChangeMonitor();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishRealtimeEvent).toHaveBeenCalledTimes(1);

    readWorkerHeartbeat.mockResolvedValue({
      name: "market-data-worker",
      status: "offline",
      lastHeartbeat: null,
      startedAt: null,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(publishRealtimeEvent).toHaveBeenCalledTimes(2);
    expect(publishRealtimeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ data: expect.objectContaining({ status: "offline" }) }),
      })
    );
    stop();
  });
});
