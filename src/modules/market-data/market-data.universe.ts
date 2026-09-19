import { and, eq, sql, type SQL } from "drizzle-orm";

import { db } from "../../db/client";
import { instruments } from "../../db/schema";
import { DATA_PROVIDER_KEY } from "../../shared/constants";
import { configuredExchanges as configuredGlobalDatafeedsExchanges } from "../data-provider/adapters/global-datafeeds/global-datafeeds.adapter";
import { getCandidateProviderKeysForExchange } from "../data-provider/data-provider.registry";
import { resolveEligibleProviders } from "../data-provider/data-provider.service";

// The one definition of "which instruments does Stock Harvesting process":
// active rows whose stored provider is the provider this exchange is routed
// to today. Rows left behind by a retired provider or exchange (e.g. old
// NSE/Zerodha rows) stay in the DB as history but never match.
export function productionProviderKeyForExchange(exchange: string): string | null {
  return getCandidateProviderKeysForExchange(exchange)[0] ?? null;
}

export function activeUniverseFilter(exchange: string): SQL {
  const providerKey = productionProviderKeyForExchange(exchange);
  if (!providerKey) return sql`false`;

  return and(
    eq(instruments.exchange, exchange),
    eq(instruments.active, true),
    eq(instruments.provider, providerKey)
  ) as SQL;
}

async function hasEligibleProvider(exchange: string): Promise<boolean> {
  const eligible = await resolveEligibleProviders({ exchange, capability: "historical_daily_candles" });
  return eligible.length > 0;
}

// Exchanges that have active production instruments AND a live (enabled,
// configured) provider - the only exchanges daily sync, freshness and admin
// counts should ever look at.
export async function listProductionExchanges(): Promise<string[]> {
  const rows = await db
    .select({ exchange: instruments.exchange, provider: instruments.provider })
    .from(instruments)
    .where(eq(instruments.active, true))
    .groupBy(instruments.exchange, instruments.provider);

  const candidates = [
    ...new Set(
      rows
        .filter((row) => productionProviderKeyForExchange(row.exchange) === row.provider)
        .map((row) => row.exchange)
    ),
  ];

  const eligibility = await Promise.all(candidates.map((exchange) => hasEligibleProvider(exchange)));
  return candidates.filter((_, index) => eligibility[index]).sort();
}

// Instrument discovery has to run before an exchange has any instruments, so
// it also covers the exchanges GlobalDataFeeds is configured for - but only
// while that provider is enabled and configured.
export async function listInstrumentSyncExchanges(): Promise<string[]> {
  const exchanges = new Set(await listProductionExchanges());

  const configured = configuredGlobalDatafeedsExchanges().filter(
    (exchange) => productionProviderKeyForExchange(exchange) === DATA_PROVIDER_KEY.globalDatafeeds
  );
  const eligibility = await Promise.all(configured.map((exchange) => hasEligibleProvider(exchange)));
  configured.forEach((exchange, index) => {
    if (eligibility[index]) exchanges.add(exchange);
  });

  return [...exchanges].sort();
}

export async function isProductionExchange(exchange: string): Promise<boolean> {
  return (await listProductionExchanges()).includes(exchange);
}

export async function isInstrumentSyncExchange(exchange: string): Promise<boolean> {
  return (await listInstrumentSyncExchanges()).includes(exchange);
}
