import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn() } }));
vi.mock("./trading-calendar", () => ({ getLatestExpectedTradingDay: vi.fn() }));
vi.mock("../jobs/background-job-runs.service", () => ({ getLastSuccessfulScheduledRefresh: vi.fn() }));
vi.mock("../market-stream/market-stream.provider-health", () => ({ getMarketStreamProviderHealth: vi.fn() }));
vi.mock("../market-stream/market-stream.capabilities", () => ({ getProviderCapabilityState: vi.fn() }));

import * as dbClientModule from "../../db/client";
import * as tradingCalendarModule from "./trading-calendar";
import * as backgroundJobRunsModule from "../jobs/background-job-runs.service";
import * as providerHealthModule from "../market-stream/market-stream.provider-health";
import * as capabilitiesModule from "../market-stream/market-stream.capabilities";
import { getMarketDataHealth } from "./market-data.health";

const db = vi.mocked(dbClientModule.db);
const getLatestExpectedTradingDay = vi.mocked(tradingCalendarModule.getLatestExpectedTradingDay);
const getLastSuccessfulScheduledRefresh = vi.mocked(backgroundJobRunsModule.getLastSuccessfulScheduledRefresh);
const getMarketStreamProviderHealth = vi.mocked(providerHealthModule.getMarketStreamProviderHealth);
const getProviderCapabilityState = vi.mocked(capabilitiesModule.getProviderCapabilityState);

function selectResult(value: number) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (value: unknown[]) => void) => Promise.resolve([{ value }]).then(resolve),
  };
  return chain as never;
}

describe("getMarketDataHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLatestExpectedTradingDay.mockReturnValue("2026-09-11");
    getLastSuccessfulScheduledRefresh.mockResolvedValue(new Date("2026-09-11T10:20:00.000Z"));
    getProviderCapabilityState.mockReturnValue({
      realtime: "unavailable",
      currentDayCandle: "unavailable",
      completedDailyHistory: "available",
      reason: "Function not enabled.",
      lastCheckedAt: "2026-09-16T08:25:46.000Z",
      retryAfter: "2026-09-16T08:35:46.000Z",
    });
    getMarketStreamProviderHealth.mockReturnValue([
      {
        provider: "global-datafeeds",
        connected: true,
        exchange: "BSE",
        lastMessageTime: "2026-09-11T09:30:00.000Z",
        activeSubscriptions: 1,
        currentDayCandlesInMemory: 1,
        lastError: null,
      },
    ]);
  });

  it("computes fresh/stale/bootstrapRequired counts purely from DB queries, no provider call", async () => {
    db.select
      .mockReturnValueOnce(selectResult(500) as never)
      .mockReturnValueOnce(selectResult(480) as never)
      .mockReturnValueOnce(selectResult(15) as never)
      .mockReturnValueOnce(selectResult(5) as never);

    const health = await getMarketDataHealth("BSE");

    expect(health).toEqual({
      exchange: "BSE",
      latestExpectedTradingDate: "2026-09-11",
      activeSymbols: 500,
      fresh: 480,
      stale: 15,
      bootstrapRequired: 5,
      lastSuccessfulRefresh: "2026-09-11T10:20:00.000Z",
      liveDelayedFeed: [
        {
          provider: "global-datafeeds",
          connected: true,
          exchange: "BSE",
          lastMessageTime: "2026-09-11T09:30:00.000Z",
          activeSubscriptions: 1,
          currentDayCandlesInMemory: 1,
          lastError: null,
        },
      ],
      providerCapabilities: [
        {
          provider: "global-datafeeds",
          exchange: "BSE",
          realtime: "unavailable",
          currentDayCandle: "unavailable",
          completedDailyHistory: "available",
          reason: "Function not enabled.",
          lastCheckedAt: "2026-09-16T08:25:46.000Z",
          retryAfter: "2026-09-16T08:35:46.000Z",
        },
      ],
      mechanisms: {
        historicalDailySync: "GDF GetHistory (Delayed)",
        currentPriceSnapshot: "GDF GetSnapshot (Delayed)",
        liveFeed: "GDF SubscribeSnapshot (Delayed)",
      },
    });
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it("reports lastSuccessfulRefresh as null when no scheduled run has ever succeeded", async () => {
    getLastSuccessfulScheduledRefresh.mockResolvedValue(null);
    db.select
      .mockReturnValueOnce(selectResult(0) as never)
      .mockReturnValueOnce(selectResult(0) as never)
      .mockReturnValueOnce(selectResult(0) as never)
      .mockReturnValueOnce(selectResult(0) as never);

    const health = await getMarketDataHealth("BSE");

    expect(health.lastSuccessfulRefresh).toBeNull();
  });
});
