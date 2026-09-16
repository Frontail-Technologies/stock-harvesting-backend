import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeRedisInstance = {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
};

const { FakeRedis, redisInstances } = vi.hoisted(() => {
  const instances: unknown[] = [];

  class FakeRedisImpl {
    handlers = new Map<string, (...args: unknown[]) => void>();
    publish = vi.fn(async () => 1);
    subscribe = vi.fn(async () => undefined);
    quit = vi.fn(async () => undefined);
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    constructor() {
      instances.push(this);
    }
  }

  return { FakeRedis: FakeRedisImpl, redisInstances: instances };
});

vi.mock("ioredis", () => ({ default: FakeRedis }));
vi.mock("./queues", () => ({
  getProducerRedisConnectionOptions: vi.fn(() => ({ host: "localhost", port: 6379 })),
  getRedisConnectionOptions: vi.fn(() => ({ host: "localhost", port: 6379 })),
}));

import * as queuesModule from "./queues";
import { closeRealtimeEvents, publishRealtimeEvent, subscribeRealtimeEvents } from "./realtime-events";

const getProducerRedisConnectionOptions = vi.mocked(queuesModule.getProducerRedisConnectionOptions);
const getRedisConnectionOptions = vi.mocked(queuesModule.getRedisConnectionOptions);
const fakeInstances = redisInstances as FakeRedisInstance[];

describe("publishRealtimeEvent / subscribeRealtimeEvents", () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  afterEach(async () => {
    await closeRealtimeEvents();
  });

  it("does nothing when Redis is not configured", async () => {
    getProducerRedisConnectionOptions.mockReturnValueOnce(null);

    await publishRealtimeEvent({
      kind: "admin",
      event: { type: "worker:status", data: { name: "market-data-worker", status: "online", lastHeartbeat: null } },
    });

    expect(redisInstances).toHaveLength(0);
  });

  it("publishes a JSON-encoded message to the realtime channel", async () => {
    await publishRealtimeEvent({
      kind: "admin",
      event: { type: "worker:status", data: { name: "market-data-worker", status: "online", lastHeartbeat: null } },
    });

    expect(fakeInstances[0].publish).toHaveBeenCalledWith(
      "market-data:realtime-events",
      expect.stringContaining("worker:status")
    );
  });

  it("never throws even when resolving the connection itself throws synchronously", async () => {
    getProducerRedisConnectionOptions.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(
      publishRealtimeEvent({
        kind: "admin",
        event: { type: "worker:status", data: { name: "market-data-worker", status: "online", lastHeartbeat: null } },
      })
    ).resolves.toBeUndefined();
  });

  it("never throws when the underlying publish call fails", async () => {
    await publishRealtimeEvent({
      kind: "admin",
      event: { type: "worker:status", data: { name: "market-data-worker", status: "online", lastHeartbeat: null } },
    });
    fakeInstances[0].publish.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      publishRealtimeEvent({
        kind: "admin",
        event: { type: "worker:status", data: { name: "market-data-worker", status: "offline", lastHeartbeat: null } },
      })
    ).resolves.toBeUndefined();
  });

  it("delivers a subscribed message to the onMessage callback", async () => {
    const received: unknown[] = [];
    subscribeRealtimeEvents((message) => received.push(message));

    const subscriberInstance = fakeInstances[0];
    subscriberInstance.emit(
      "message",
      "market-data:realtime-events",
      JSON.stringify({ kind: "admin", event: { type: "worker:status", data: { name: "x", status: "online", lastHeartbeat: null } } })
    );

    expect(received).toHaveLength(1);
    expect((received[0] as { kind: string }).kind).toBe("admin");
  });

  it("ignores messages on unrelated channels", async () => {
    const received: unknown[] = [];
    subscribeRealtimeEvents((message) => received.push(message));

    fakeInstances[0].emit("message", "some-other-channel", "{}");

    expect(received).toHaveLength(0);
  });

  it("returns null and does not create a client when Redis is not configured for subscribing", () => {
    getRedisConnectionOptions.mockReturnValueOnce(null);

    const result = subscribeRealtimeEvents(() => undefined);

    expect(result).toBeNull();
  });
});
