import { DATA_PROVIDER_KEY, DEFAULT_EXCHANGE } from "../../shared/constants";
import { EodhdDataProviderAdapter } from "./adapters/eodhd-data-provider.adapter";
import { GlobalDatafeedsDataProviderAdapter } from "./adapters/global-datafeeds/global-datafeeds.adapter";
import { ZerodhaDataProviderAdapter } from "./adapters/zerodha-data-provider.adapter";
import type { DataProviderAdapter } from "./data-provider.types";

const eodhdAdapter = new EodhdDataProviderAdapter();
const zerodhaAdapter = new ZerodhaDataProviderAdapter();
const globalDatafeedsAdapter = new GlobalDatafeedsDataProviderAdapter();

const adaptersByProvider = {
  [DATA_PROVIDER_KEY.eodhd]: eodhdAdapter,
  [DATA_PROVIDER_KEY.zerodha]: zerodhaAdapter,
  [DATA_PROVIDER_KEY.globalDatafeeds]: globalDatafeedsAdapter,
} satisfies Record<string, DataProviderAdapter>;

// Exchanges with special-cased provider routing — everything else (all of
// EODHD's ~70 exchanges) falls through to EODHD by default below. NOT
// exhaustive over every supported exchange code on purpose — the exchange
// list is now dynamic (see market-data.service.ts's listSupportedExchanges),
// so this can't be a closed Record without breaking on every new exchange.
const providerByExchange: Record<string, keyof typeof adaptersByProvider> = {
  NSE: DATA_PROVIDER_KEY.zerodha,
  NSE_IDX: DATA_PROVIDER_KEY.zerodha,
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

export function getConnectableDataProviderAdapter(): DataProviderAdapter {
  return zerodhaAdapter;
}

export function listDataProviderAdapters(): DataProviderAdapter[] {
  return Object.values(adaptersByProvider);
}
