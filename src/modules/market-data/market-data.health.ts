import { and, count, eq, gte, isNull, lt } from "drizzle-orm";

import { db } from "../../db/client";
import { instruments } from "../../db/schema";
import { DEFAULT_EXCHANGE } from "../../shared/constants";
import { getLastSuccessfulScheduledRefresh } from "../jobs/background-job-runs.service";
import { getProviderCapabilityState, type MarketStreamCapabilityState } from "../market-stream/market-stream.capabilities";
import { getMarketStreamProviderHealth, type MarketStreamProviderHealth } from "../market-stream/market-stream.provider-health";
import { getLatestExpectedTradingDay } from "./trading-calendar";

export type MarketDataHealthMechanisms = {
  historicalDailySync: string;
  currentPriceSnapshot: string;
  liveFeed: string;
};

export type MarketDataHealth = {
  exchange: string;
  latestExpectedTradingDate: string;
  activeSymbols: number;
  fresh: number;
  stale: number;
  bootstrapRequired: number;
  lastSuccessfulRefresh: string | null;
  liveDelayedFeed: MarketStreamProviderHealth[];
  providerCapabilities: Array<MarketStreamCapabilityState & { provider: string; exchange?: string }>;
  mechanisms: MarketDataHealthMechanisms;
};

export async function getMarketDataHealth(exchange: string = DEFAULT_EXCHANGE): Promise<MarketDataHealth> {
  const latestExpectedTradingDate = getLatestExpectedTradingDay(exchange);
  const activeFilter = and(eq(instruments.exchange, exchange), eq(instruments.active, true));

  const [[activeRow], [freshRow], [staleRow], [bootstrapRow], lastSuccessfulRefresh] = await Promise.all([
    db.select({ value: count() }).from(instruments).where(activeFilter),
    db
      .select({ value: count() })
      .from(instruments)
      .where(and(activeFilter, gte(instruments.latestPriceAt, latestExpectedTradingDate))),
    db
      .select({ value: count() })
      .from(instruments)
      .where(and(activeFilter, lt(instruments.latestPriceAt, latestExpectedTradingDate))),
    db.select({ value: count() }).from(instruments).where(and(activeFilter, isNull(instruments.latestPriceAt))),
    getLastSuccessfulScheduledRefresh(),
  ]);

  return {
    exchange,
    latestExpectedTradingDate,
    activeSymbols: activeRow.value,
    fresh: freshRow.value,
    stale: staleRow.value,
    bootstrapRequired: bootstrapRow.value,
    lastSuccessfulRefresh: lastSuccessfulRefresh ? lastSuccessfulRefresh.toISOString() : null,
    liveDelayedFeed: getMarketStreamProviderHealth(),
    providerCapabilities: [
      {
        provider: "global-datafeeds",
        exchange: "BSE",
        ...getProviderCapabilityState("global-datafeeds", "BSE"),
      },
    ],
    mechanisms: {
      historicalDailySync: "GDF GetHistory (Delayed)",
      currentPriceSnapshot: "GDF GetSnapshot (Delayed)",
      liveFeed: "GDF SubscribeSnapshot (Delayed)",
    },
  };
}
