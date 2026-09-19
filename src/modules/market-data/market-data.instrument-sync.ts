import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { instruments } from "../../db/schema";
import { DEFAULT_EXCHANGE } from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import { getActiveProviderAccessToken, getEligibleProviderAdapter } from "../data-provider/data-provider.service";
import { recordProviderFailure, recordProviderSuccess } from "../data-provider/data-provider-settings.service";
import { enqueueCandleBootstrapJobs } from "../jobs/queues";
import { createFallbackInstrument, getInstrumentsBySymbol, upsertInstruments } from "./market-data.instruments";

// Instrument existence -> provider search -> full-sync fallback -> fallback creation -> default hydration; owns "make sure an instrument row exists" end to end. Deliberately does NOT own candle backfill/sync/refresh orchestration (still in market-data.service.ts) - this module only depends on market-data.instruments.ts and neutral data-provider services, never market-data.service.ts, avoiding an import cycle.

function scheduleCandleBootstrap(exchange: string, symbols: string[]) {
  void enqueueCandleBootstrapJobs(exchange, symbols).catch((error) => {
    logger.warn(
      { exchange, symbolCount: symbols.length, message: getErrorMessage(error, "Unknown error") },
      "Failed to enqueue initial candle bootstrap",
    );
  });
}

export async function getOrCreateInstrument(
  symbol: string,
  exchange: string = DEFAULT_EXCHANGE,
  dbClient: DbOrTx = db
) {
  const [instrument] = await dbClient
    .select()
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.symbol, normalizeSymbol(symbol))))
    .limit(1);

  if (instrument) return instrument;

  await ensureInstrumentsForSymbols([symbol], exchange);
  const [created] = await dbClient
    .select()
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.symbol, normalizeSymbol(symbol))))
    .limit(1);

  return created;
}

export async function ensureInstrumentsForSymbols(symbols: string[], exchange: string = DEFAULT_EXCHANGE) {
  const existing = await getInstrumentsBySymbol(symbols, exchange);
  const missingSymbols = symbols.filter((symbol) => !existing.has(symbol));

  if (missingSymbols.length === 0) return;

  const searchAdapter = await getEligibleProviderAdapter({ exchange, capability: "instrument_search" });

  if (searchAdapter?.searchInstruments) {
    for (const symbol of missingSymbols) {
      await syncProviderInstrumentSearch(symbol, exchange);
    }
  } else {
    await syncProviderInstruments(exchange);
  }

  const synced = await getInstrumentsBySymbol(missingSymbols, exchange);
  const stillMissingSymbols = missingSymbols.filter((symbol) => !synced.has(symbol));
  if (!(await canCreateFallbackInstrument(exchange))) return;

  for (const symbol of stillMissingSymbols) {
    await createFallbackInstrument(symbol, exchange);
  }
}

export async function syncProviderInstrumentSearch(query: string, exchange: string = DEFAULT_EXCHANGE) {
  const searchQuery = normalizeSymbol(query);
  // No eligible provider AND "eligible but doesn't implement search" (e.g. an adapter without a search API) both land here - either way the fallback is a full instrument sync through this exchange's own (independently eligibility-gated) primary provider.
  const adapter = await getEligibleProviderAdapter({ exchange, capability: "instrument_search" });
  if (!adapter || !adapter.searchInstruments) {
    await syncProviderInstruments(exchange);
    return { count: 0 };
  }

  let providerInstruments;
  try {
    providerInstruments = await adapter.searchInstruments(searchQuery, exchange);
    void recordProviderSuccess(adapter.providerKey);
  } catch (error) {
    void recordProviderFailure(adapter.providerKey, error);
    throw error;
  }

  if (providerInstruments.length === 0) {
    if (!(await canCreateFallbackInstrument(exchange))) return { count: 0 };
    await createFallbackInstrument(searchQuery, exchange);
    return { count: 1 };
  }

  await upsertInstruments(providerInstruments, adapter.providerKey);
  scheduleCandleBootstrap(exchange, providerInstruments.map((instrument) => instrument.symbol));

  return { count: providerInstruments.length };
}

export async function syncProviderInstruments(exchange: string) {
  const adapter = await getEligibleProviderAdapter({ exchange, capability: "instrument_sync" });
  if (!adapter) return { count: 0 };

  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  let providerInstruments;
  try {
    providerInstruments = await adapter.fetchInstruments({
      accessToken,
      exchangeCode: exchange,
    });
    void recordProviderSuccess(adapter.providerKey);
  } catch (error) {
    void recordProviderFailure(adapter.providerKey, error);
    throw error;
  }

  const existing = await getInstrumentsBySymbol(providerInstruments.map((instrument) => instrument.symbol), exchange);
  await upsertInstruments(providerInstruments, adapter.providerKey);
  scheduleCandleBootstrap(
    exchange,
    providerInstruments.map((instrument) => instrument.symbol).filter((symbol) => !existing.has(symbol)),
  );

  return { count: providerInstruments.length };
}

export async function canCreateFallbackInstrument(exchange: string) {
  const adapter = await getEligibleProviderAdapter({ exchange, capability: "instrument_token" });
  return Boolean(adapter?.getInstrumentToken);
}

// Populates an exchange's instruments from its own provider - the only source
// of the instrument universe. There is deliberately no static symbol list to
// fall back to: if the provider sync fails or returns nothing, the exchange
// simply stays as it is.
export async function hydrateMarketInstruments(exchange: string) {
  try {
    return await syncProviderInstruments(exchange);
  } catch (error) {
    logger.warn(
      { exchange, message: getErrorMessage(error) },
      "Provider instrument sync failed during hydration"
    );
    return { count: 0 };
  }
}
