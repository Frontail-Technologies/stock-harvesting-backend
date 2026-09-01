import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { instruments } from "../../db/schema";
import { DEFAULT_EXCHANGE } from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import { getActiveProviderAccessToken, getEligibleProviderAdapter } from "../data-provider/data-provider.service";
import { recordProviderFailure, recordProviderSuccess } from "../data-provider/data-provider-settings.service";
import { createFallbackInstrument, getInstrumentsBySymbol, upsertInstruments } from "./market-data.instruments";

// Instrument existence -> provider search -> full-sync fallback -> fallback
// creation -> default hydration. Owns "make sure an instrument row exists
// for this symbol" end to end. Deliberately does NOT own candle backfill/
// sync/refresh orchestration (still in market-data.service.ts, see B2 of
// the provider-orchestration boundary audit) - this module only ever
// depends on market-data.instruments.ts and the neutral data-provider
// services, never on market-data.service.ts, so it can be called from
// anywhere without risking an import cycle.

const DEFAULT_MARKET_SYMBOLS_BY_EXCHANGE: Record<string, readonly string[]> = {
  US: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "JPM", "V", "UNH", "XOM", "AVGO"],
  NSE: [
    "RELIANCE",
    "TCS",
    "INFY",
    "HDFCBANK",
    "ICICIBANK",
    "SBIN",
    "BHARTIARTL",
    "ITC",
    "LT",
    "HINDUNILVR",
    "KOTAKBANK",
    "AXISBANK",
  ],
};

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

  for (const symbol of missingSymbols) {
    await syncProviderInstrumentSearch(symbol, exchange);
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
  // No eligible provider AND "eligible but doesn't implement search" (e.g.
  // Zerodha for NSE) both land here - either way, the existing fallback is
  // the same: a full instrument sync through this exchange's own primary
  // provider, which is itself independently eligibility-gated already.
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

  return { count: providerInstruments.length };
}

export async function syncProviderInstruments(exchange: string = DEFAULT_EXCHANGE) {
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

  await upsertInstruments(providerInstruments, adapter.providerKey);

  return { count: providerInstruments.length };
}

export async function canCreateFallbackInstrument(exchange: string) {
  const adapter = await getEligibleProviderAdapter({ exchange, capability: "instrument_token" });
  return Boolean(adapter?.getInstrumentToken);
}

export async function hydrateDefaultFallbackInstruments(exchange: string = DEFAULT_EXCHANGE) {
  if (!(await canCreateFallbackInstrument(exchange))) return { count: 0 };

  // Only a curated list for this exact exchange is safe to seed - falling
  // back to DEFAULT_EXCHANGE's list here would silently seed US tickers
  // (AAPL, MSFT, ...) onto an unrelated exchange. The primary path (a full
  // syncProviderInstruments pull) already handles real seeding for any
  // exchange without needing a curated list at all; this fallback only
  // exists for the handful of exchanges with a hand-picked list.
  const defaultSymbols = DEFAULT_MARKET_SYMBOLS_BY_EXCHANGE[exchange];
  if (!defaultSymbols) return { count: 0 };

  let count = 0;

  for (const symbol of defaultSymbols) {
    try {
      const result = await syncProviderInstrumentSearch(symbol, exchange);
      count += result.count;
    } catch {
      await createFallbackInstrument(symbol, exchange);
      count++;
    }
  }

  return { count };
}

export async function hydrateDefaultMarketInstruments(exchange: string = DEFAULT_EXCHANGE) {
  try {
    const result = await syncProviderInstruments(exchange);
    if (result.count > 0) return result;
  } catch (error) {
    // Best-effort by design: falls back to the static default list rather
    // than failing the request - this is still worth a low-noise trace so
    // a persistently-failing provider sync isn't completely invisible.
    logger.warn(
      { exchange, message: getErrorMessage(error) },
      "Provider instrument sync failed; falling back to default instrument list"
    );
    return hydrateDefaultFallbackInstruments(exchange);
  }

  return hydrateDefaultFallbackInstruments(exchange);
}
