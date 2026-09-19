import {
  DATA_PROVIDER_KEY,
  DEFAULT_EXCHANGE,
  PROVIDER_CAPABILITIES,
  type ProviderCapability,
} from "../../shared/constants";
import { EodhdDataProviderAdapter } from "./adapters/eodhd-data-provider.adapter";
import { GlobalDatafeedsDataProviderAdapter } from "./adapters/global-datafeeds/global-datafeeds.adapter";
import type { DataProviderAdapter } from "./data-provider.types";

const eodhdAdapter = new EodhdDataProviderAdapter();
const globalDatafeedsAdapter = new GlobalDatafeedsDataProviderAdapter();

const adaptersByProvider = {
  [DATA_PROVIDER_KEY.eodhd]: eodhdAdapter,
  [DATA_PROVIDER_KEY.globalDatafeeds]: globalDatafeedsAdapter,
} satisfies Record<string, DataProviderAdapter>;

// Exchanges with special-cased provider routing — everything else (all of
// EODHD's ~70 exchanges) falls through to EODHD by default below. NOT
// exhaustive over every supported exchange code on purpose — the exchange
// list is now dynamic (see market-data.service.ts's listSupportedExchanges),
// so this can't be a closed Record without breaking on every new exchange.
// NSE / NSE_IDX were served only by the retired Zerodha integration. They are
// deliberately NOT left to fall through to the EODHD default below - that would
// silently put NSE onto a provider nobody chose for it - so they resolve to no
// provider at all.
export const RETIRED_EXCHANGE_CODES: ReadonlySet<string> = new Set(["NSE", "NSE_IDX"]);

const providerByExchange: Record<string, keyof typeof adaptersByProvider> = {
  BSE: DATA_PROVIDER_KEY.globalDatafeeds,
  BSE_IDX: DATA_PROVIDER_KEY.globalDatafeeds,
};

export function getDataProviderAdapterForExchange(
  exchange: string = DEFAULT_EXCHANGE
): DataProviderAdapter {
  const providerKey = providerByExchange[exchange] ?? DATA_PROVIDER_KEY.eodhd;
  return adaptersByProvider[providerKey];
}

export function getEodhdDataProviderAdapter(): EodhdDataProviderAdapter {
  return eodhdAdapter;
}

export function getDataProviderAdapterByProvider(
  provider: string
): DataProviderAdapter | null {
  return adaptersByProvider[provider as keyof typeof adaptersByProvider] ?? null;
}

export function listDataProviderAdapters(): DataProviderAdapter[] {
  return Object.values(adaptersByProvider);
}

// Today's routing is a strict 1:1 exchange->provider map (see
// providerByExchange above) - there is no existing multi-provider-per-
// exchange fallback to preserve, so this always returns exactly one
// candidate key. It's still shaped as an array (not a single key) so the
// eligibility layer in data-provider.service.ts is genuinely general and
// doesn't need to change if a second real candidate is ever added for some
// exchange - it just doesn't fabricate one today.
export function getCandidateProviderKeysForExchange(
  exchange: string = DEFAULT_EXCHANGE
): string[] {
  if (RETIRED_EXCHANGE_CODES.has(exchange)) return [];
  return [providerByExchange[exchange] ?? DATA_PROVIDER_KEY.eodhd];
}

// realtime_ws isn't a DataProviderAdapter method (see data-provider.types.ts)
// - it corresponds to a class existing under
// market-stream/providers/{eodhd,global-datafeeds}-market-stream.provider.ts.
// Both current providers have one, confirmed by direct audit of that
// directory - not assumed.
const REALTIME_CAPABLE_PROVIDER_KEYS = new Set<string>([
  DATA_PROVIDER_KEY.globalDatafeeds,
  DATA_PROVIDER_KEY.eodhd,
]);

export function adapterSupportsCapability(
  adapter: DataProviderAdapter,
  capability: ProviderCapability
): boolean {
  switch (capability) {
    case "instrument_sync":
    case "historical_daily_candles":
      return true;
    case "latest_daily_candles":
      return Boolean(adapter.fetchLatestDailyCandles);
    case "instrument_search":
      return Boolean(adapter.searchInstruments);
    case "instrument_token":
      return Boolean(adapter.getInstrumentToken);
    case "exchange_list":
      return Boolean(adapter.fetchExchanges);
    case "realtime_ws":
      return REALTIME_CAPABLE_PROVIDER_KEYS.has(adapter.providerKey);
    case "current_price_snapshot":
      return Boolean(adapter.fetchDelayedSnapshot);
    default:
      return false;
  }
}

export function getProviderCapabilities(adapter: DataProviderAdapter): ProviderCapability[] {
  return PROVIDER_CAPABILITIES.filter((capability) =>
    adapterSupportsCapability(adapter, capability)
  );
}
