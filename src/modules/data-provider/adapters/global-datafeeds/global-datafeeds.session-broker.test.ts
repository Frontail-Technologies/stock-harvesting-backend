import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One GDF session per key: only the elected owner (worker) may open the socket; every other process
// reaches GDF through the owner over Redis. Redis is replaced by an in-memory bus.

const bus = vi.hoisted(() => {
  type Handler = (channel: string, message: string) => void;
  const store = new Map<string, string>();
  const subscriptions = new Map<string, Set<{ handlers: Handler[] }>>();
  return { store, subscriptions };
});

vi.mock("../../../../shared/env", () => ({
  env: { REDIS_URL: "redis://localhost:6379", GLOBAL_DATAFEEDS_SESSION_MODE: "broker" },
}));

vi.mock("ioredis", () => {
  class FakeRedis {
    handlers: Array<(channel: string, message: string) => void> = [];
    on(event: string, handler: (channel: string, message: string) => void) {
      if (event === "message") this.handlers.push(handler);
      return this;
    }
    async subscribe(...channels: string[]) {
      for (const channel of channels) {
        if (!bus.subscriptions.has(channel)) bus.subscriptions.set(channel, new Set());
        bus.subscriptions.get(channel)!.add(this as never);
      }
    }
    async unsubscribe(...channels: string[]) {
      for (const channel of channels) bus.subscriptions.get(channel)?.delete(this as never);
    }
    async publish(channel: string, message: string) {
      for (const subscriber of bus.subscriptions.get(channel) ?? []) {
        for (const handler of (subscriber as unknown as FakeRedis).handlers) {
          setImmediate(() => handler(channel, message));
        }
      }
      return 1;
    }
    async set(key: string, value: string, _ex: string, _ttl: number, _nx: string) {
      if (bus.store.has(key)) return null;
      bus.store.set(key, value);
      return "OK";
    }
    async get(key: string) {
      return bus.store.get(key) ?? null;
    }
    async eval(script: string, _keys: number, key: string, id: string) {
      if (bus.store.get(key) !== id) return 0;
      if (script.includes("'del'")) bus.store.delete(key);
      return 1;
    }
    async quit() {
      for (const subscribers of bus.subscriptions.values()) subscribers.delete(this as never);
    }
  }
  return { default: FakeRedis };
});

import { ProviderRateLimitedError } from "../../../../shared/errors";
import { GdfSessionBroker } from "./global-datafeeds.session-broker";
import type { GlobalDatafeedsWebSocketClient } from "./global-datafeeds.websocket-client";

function fakeClient() {
  const quoteListeners = new Set<(quote: unknown) => void>();
  const statusListeners = new Set<(connected: boolean, message?: string) => void>();
  const client = {
    transport: null as null | { request: (...args: never[]) => Promise<unknown>; send: (...args: never[]) => Promise<void> },
    request: vi.fn(async () => ({ MessageType: "InstrumentsResult", Result: [{ Identifier: "TCS" }] })),
    send: vi.fn(async () => undefined),
    close: vi.fn(),
    setStartupGate: vi.fn(),
    setRemoteTransport(transport: unknown) {
      client.transport = transport as never;
    },
    addQuoteListener(listener: (quote: unknown) => void) {
      quoteListeners.add(listener);
      return () => quoteListeners.delete(listener);
    },
    addStatusListener(listener: (connected: boolean, message?: string) => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    ingestRemoteQuote: vi.fn(),
    ingestRemoteStatus: vi.fn(),
    emitQuote: (quote: unknown) => quoteListeners.forEach((listener) => listener(quote)),
    emitStatus: (connected: boolean, message?: string) => statusListeners.forEach((listener) => listener(connected, message)),
  };
  return client;
}

const asClient = (client: ReturnType<typeof fakeClient>) => client as unknown as GlobalDatafeedsWebSocketClient;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const started: GdfSessionBroker[] = [];
async function startBroker(role: "owner-candidate" | "proxy", client = fakeClient()) {
  const broker = new GdfSessionBroker(role, asClient(client), 0);
  started.push(broker);
  await broker.start();
  return { broker, client };
}

beforeEach(() => {
  bus.store.clear();
  bus.subscriptions.clear();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((broker) => broker.stop()));
});

describe("session ownership", () => {
  it("the worker wins the lease and is the only process that uses a local socket", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");

    expect(worker.broker.isOwner()).toBe(true);
    expect(worker.client.transport).toBeNull(); // uses its own socket
    expect(api.broker.isOwner()).toBe(false);
    expect(api.client.transport).not.toBeNull(); // never opens a socket
  });

  it("a second candidate does not become an owner while the first holds the lease", async () => {
    const first = await startBroker("owner-candidate");
    const second = await startBroker("owner-candidate");

    expect(first.broker.isOwner()).toBe(true);
    expect(second.broker.isOwner()).toBe(false);
    expect(second.client.transport).not.toBeNull();
  });

  it("releases the lease on stop so the next candidate can take over immediately", async () => {
    const first = await startBroker("owner-candidate");
    await first.broker.stop();

    const second = await startBroker("owner-candidate");
    expect(second.broker.isOwner()).toBe(true);
  });
});

describe("requests from a non-owner process", () => {
  it("are executed by the owner's socket and the response is returned", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");
    const request = { MessageType: "GetInstruments", Exchange: "BSE" };

    const response = await api.client.transport!.request(request as never, 5_000 as never);

    expect(worker.client.request).toHaveBeenCalledWith(request, 5_000);
    expect(api.client.request).not.toHaveBeenCalled();
    expect(response).toEqual({ MessageType: "InstrumentsResult", Result: [{ Identifier: "TCS" }] });
  });

  it("carry the owner's error back to the caller", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");
    worker.client.request.mockRejectedValueOnce(new Error("Global Datafeeds request timed out: GetHistory"));

    await expect(api.client.transport!.request({ MessageType: "GetHistory" } as never, 100 as never)).rejects.toThrow(
      "timed out: GetHistory",
    );
  });

  it("keep the rate-limit error type and cooldown when the owner is being rate limited by GDF", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");
    worker.client.request.mockRejectedValueOnce(new ProviderRateLimitedError("Global Datafeeds", 300_000));

    const error = await api.client.transport!.request({ MessageType: "GetHistory" } as never, 100 as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect((error as ProviderRateLimitedError).retryAfterMs).toBe(300_000);
  });

  it("fail immediately, without waiting for a timeout, when no owner is running", async () => {
    const api = await startBroker("proxy");
    const startedAt = Date.now();

    await expect(api.client.transport!.request({ MessageType: "GetInstruments" } as never, 30_000 as never)).rejects.toThrow(
      "session owner (the worker) is not running",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("forward fire-and-forget sends to the owner", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");

    await api.client.transport!.send({ MessageType: "SubscribeSnapshot" } as never);
    await tick();

    expect(worker.client.send).toHaveBeenCalledWith({ MessageType: "SubscribeSnapshot" });
  });
});

describe("live data relay", () => {
  it("quotes received by the owner reach the API's listeners", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");

    worker.client.emitQuote({ MessageType: "RealtimeSnapshotResult", InstrumentIdentifier: "TCS", LastTradePrice: 4000 });
    await tick();

    expect(api.client.ingestRemoteQuote).toHaveBeenCalledWith(expect.objectContaining({ InstrumentIdentifier: "TCS" }));
    expect(worker.client.ingestRemoteQuote).not.toHaveBeenCalled(); // the owner never re-ingests its own quotes
  });

  it("connection status changes on the owner reach the API", async () => {
    const worker = await startBroker("owner-candidate");
    const api = await startBroker("proxy");

    worker.client.emitStatus(false, "socket closed");
    await tick();

    expect(api.client.ingestRemoteStatus).toHaveBeenCalledWith(false, "socket closed");
  });
});

describe("a broker that cannot start", () => {
  it("reports itself as not started, so callers can refuse to fall back to a direct socket", async () => {
    const broker = new GdfSessionBroker("proxy", asClient(fakeClient()), 0);

    expect(broker.isStarted()).toBe(false);
    await broker.start();
    expect(broker.isStarted()).toBe(true);
    await broker.stop();
  });
});
