import { and, count, gte, isNull, lt } from "drizzle-orm";

import { db } from "../../db/client";
import { instruments } from "../../db/schema";
import { DATA_PROVIDER_KEY } from "../../shared/constants";
import { getLastSuccessfulScheduledRefresh } from "../jobs/background-job-runs.service";
import { getProviderCapabilityState, type MarketStreamCapabilityState } from "../market-stream/market-stream.capabilities";
import { getMarketStreamProviderHealth, type MarketStreamProviderHealth } from "../market-stream/market-stream.provider-health";
import { getLatestExpectedTradingDay } from "./trading-calendar";
import { activeUniverseFilter, listProductionExchanges, productionProviderKeyForExchange } from "./market-data.universe";

export type MarketDataHealthMechanisms = {
  historicalDailySync: string;
  currentPriceSnapshot: string;
  liveFeed: string;
};

export type MarketDataHealth = {
  exchange: string;
  exchanges: string[];
  latestExpectedTradingDate: string | null;
  activeSymbols: number;
  fresh: number;
  stale: number;
  bootstrapRequired: number;
  lastSuccessfulRefresh: string | null;
  liveDelayedFeed: MarketStreamProviderHealth[];
  providerCapabilities: Array<MarketStreamCapabilityState & { provider: string; exchange?: string }>;
  mechanisms: MarketDataHealthMechanisms;
};

async function countExchangeUniverse(exchange: string) {
  const latestExpectedTradingDate = getLatestExpectedTradingDay(exchange);
  const universe = activeUniverseFilter(exchange);

  const [[activeRow], [freshRow], [staleRow], [bootstrapRow]] = await Promise.all([
    db.select({ value: count() }).from(instruments).where(universe),
    db
      .select({ value: count() })
      .from(instruments)
      .where(and(universe, gte(instruments.latestPriceAt, latestExpectedTradingDate))),
    db
      .select({ value: count() })
      .from(instruments)
      .where(and(universe, lt(instruments.latestPriceAt, latestExpectedTradingDate))),
    db.select({ value: count() }).from(instruments).where(and(universe, isNull(instruments.latestPriceAt))),
  ]);

  return {
    exchange,
    latestExpectedTradingDate,
    activeSymbols: activeRow.value,
    fresh: freshRow.value,
    stale: staleRow.value,
    bootstrapRequired: bootstrapRow.value,
  };
}

// Every count comes from the same production universe (activeUniverseFilter)
// the scheduler syncs. With no exchange given, it covers every production
// exchange - never a hardcoded default exchange.
export async function getMarketDataHealth(exchange?: string): Promise<MarketDataHealth> {
  const exchanges = exchange ? [exchange] : await listProductionExchanges();
  const [perExchange, lastSuccessfulRefresh] = await Promise.all([
    Promise.all(exchanges.map((code) => countExchangeUniverse(code))),
    getLastSuccessfulScheduledRefresh(),
  ]);

  const expectedDates = perExchange.map((entry) => entry.latestExpectedTradingDate).sort();
  const sum = (pick: (entry: (typeof perExchange)[number]) => number) =>
    perExchange.reduce((total, entry) => total + pick(entry), 0);

  return {
    exchange: exchanges.length === 1 ? exchanges[0] : "ALL",
    exchanges,
    latestExpectedTradingDate: expectedDates[0] ?? null,
    activeSymbols: sum((entry) => entry.activeSymbols),
    fresh: sum((entry) => entry.fresh),
    stale: sum((entry) => entry.stale),
    bootstrapRequired: sum((entry) => entry.bootstrapRequired),
    lastSuccessfulRefresh: lastSuccessfulRefresh ? lastSuccessfulRefresh.toISOString() : null,
    liveDelayedFeed: getMarketStreamProviderHealth(),
    providerCapabilities: exchanges
      .filter((code) => productionProviderKeyForExchange(code) === DATA_PROVIDER_KEY.globalDatafeeds)
      .map((code) => ({
        provider: DATA_PROVIDER_KEY.globalDatafeeds,
        exchange: code,
        ...getProviderCapabilityState(DATA_PROVIDER_KEY.globalDatafeeds, code),
      })),
    mechanisms: {
      historicalDailySync: "GDF GetHistory (Delayed)",
      currentPriceSnapshot: "GDF GetSnapshot (Delayed)",
      liveFeed: "GDF SubscribeSnapshot (Delayed)",
    },
  };
}
