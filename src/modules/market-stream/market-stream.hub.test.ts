import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../price-alerts/price-alerts.service", () => ({ evaluatePriceAlertsForQuote: vi.fn() }));

import {
  getMarketStreamStats,
  publishAdminMarketDataEvent,
  publishMarketStreamEvent,
  registerMarketStreamClient,
} from "./market-stream.hub";
import type { MarketStreamUser } from "./market-stream.types";

function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    OPEN: 1,
    readyState: 1,
    sent: [] as unknown[],
    send: vi.fn(function (this: { sent: unknown[] }, payload: string) {
      this.sent.push(JSON.parse(payload));
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    close: () => handlers.get("close")?.(),
  };
}

function user(overrides: Partial<MarketStreamUser> = {}): MarketStreamUser {
  return { id: "u1", email: "a@b.com", role: "user", plan: "free", portal: "user", ...overrides };
}

describe("admin market-data fan-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers an admin event only to admin-subscribed clients", () => {
    const adminSocket = fakeSocket();
    const normalSocket = fakeSocket();

    const adminClient = registerMarketStreamClient(adminSocket as never, user({ portal: "admin", role: "admin" }));
    registerMarketStreamClient(normalSocket as never, user());

    adminClient.subscribeAdmin();

    publishAdminMarketDataEvent({
      type: "market-data:job-started",
      data: { runId: "run-1", jobType: "daily_candle_morning", startedAt: "2026-09-16T09:40:00.000Z" },
    });

    const adminMessages = adminSocket.sent.filter((m: unknown) => (m as { type?: string }).type === "market-data:job-started");
    const normalMessages = normalSocket.sent.filter((m: unknown) => (m as { type?: string }).type === "market-data:job-started");

    expect(adminMessages).toHaveLength(1);
    expect(normalMessages).toHaveLength(0);

    adminSocket.close();
    normalSocket.close();
  });

  it("stops delivering admin events after unsubscribeAdmin", () => {
    const adminSocket = fakeSocket();
    const adminClient = registerMarketStreamClient(adminSocket as never, user({ portal: "admin", role: "admin" }));

    adminClient.subscribeAdmin();
    adminClient.unsubscribeAdmin();
    adminSocket.sent.length = 0;

    publishAdminMarketDataEvent({
      type: "worker:status",
      data: { name: "market-data-worker", status: "online", lastHeartbeat: null },
    });

    expect(adminSocket.sent).toHaveLength(0);
    adminSocket.close();
  });

  it("routes a symbol-refreshed event only to clients subscribed to that exact exchange/symbol", () => {
    const tcsSocket = fakeSocket();
    const relianceSocket = fakeSocket();

    const tcsClient = registerMarketStreamClient(tcsSocket as never, user());
    registerMarketStreamClient(relianceSocket as never, user());

    tcsClient.subscribe([{ exchange: "BSE", symbol: "TCS" }]);
    tcsSocket.sent.length = 0;
    relianceSocket.sent.length = 0;

    publishMarketStreamEvent({
      type: "market.symbol.refreshed",
      data: {
        exchange: "BSE",
        symbol: "TCS",
        instrumentId: "i1",
        latestDataDate: "2026-09-16",
        status: "updated",
        time: "2026-09-16T10:00:00.000Z",
      },
    });

    expect(tcsSocket.sent).toHaveLength(1);
    expect(relianceSocket.sent).toHaveLength(0);

    tcsSocket.close();
    relianceSocket.close();
  });

  it("reports admin subscriber counts in stats", () => {
    const adminSocket = fakeSocket();
    const adminClient = registerMarketStreamClient(adminSocket as never, user({ portal: "admin", role: "admin" }));
    adminClient.subscribeAdmin();

    expect(getMarketStreamStats().adminSubscribers).toBeGreaterThanOrEqual(1);
    adminSocket.close();
  });
});
