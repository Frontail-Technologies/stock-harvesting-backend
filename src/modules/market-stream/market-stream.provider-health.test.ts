import { describe, expect, it } from "vitest";

import { applyProviderDailyCandle } from "./market-stream-candles";
import {
  getMarketStreamProviderHealth,
  updateProviderConnection,
  updateProviderLastMessage,
  updateProviderSubscriptions,
} from "./market-stream.provider-health";

describe("market stream provider health", () => {
  it("reports connection, provider timestamp, active subscriptions and in-memory candle count", () => {
    const exchange = `BSE_HEALTH_${Date.now()}`;
    updateProviderConnection({ provider: "global-datafeeds", exchange, connected: true });
    updateProviderSubscriptions({
      provider: "global-datafeeds",
      exchange,
      subscriptions: [{ exchange, symbol: "TCS" }],
    });
    updateProviderLastMessage({
      provider: "global-datafeeds",
      exchange,
      time: "2026-09-16T09:45:00.000Z",
    });
    applyProviderDailyCandle({
      exchange,
      symbol: "TCS",
      time: "2026-09-16T09:45:00.000Z",
      open: 100,
      high: 105,
      low: 99,
      close: 103,
    });

    expect(getMarketStreamProviderHealth()).toContainEqual({
      provider: "global-datafeeds",
      exchange,
      connected: true,
      lastMessageTime: "2026-09-16T09:45:00.000Z",
      activeSubscriptions: 1,
      currentDayCandlesInMemory: 1,
      lastError: null,
    });
  });
});
