import { EodhdMarketStreamProvider } from "./providers/eodhd-market-stream.provider";
import { GlobalDatafeedsMarketStreamProvider } from "./providers/global-datafeeds-market-stream.provider";
import { KiteMarketStreamProvider } from "./providers/kite-market-stream.provider";
import type { MarketStreamSymbol } from "./market-stream.types";
import { DATA_PROVIDER_KEY } from "../../shared/constants";
import { logger } from "../../shared/logger";
import { isProviderEnabled } from "../data-provider/data-provider-settings.service";

const eodhdProvider = new EodhdMarketStreamProvider();
const kiteProvider = new KiteMarketStreamProvider();
const globalDatafeedsProvider = new GlobalDatafeedsMarketStreamProvider();

function splitByProvider(symbols: MarketStreamSymbol[]): {
  nse: MarketStreamSymbol[];
  globalDatafeeds: MarketStreamSymbol[];
  other: MarketStreamSymbol[];
} {
  return {
    nse: symbols.filter((symbol) => symbol.exchange === "NSE"),
    globalDatafeeds: symbols.filter(
      (symbol) => symbol.exchange === "BSE" || symbol.exchange === "BSE_IDX",
    ),
    other: symbols.filter(
      (symbol) =>
        symbol.exchange !== "NSE" &&
        symbol.exchange !== "BSE" &&
        symbol.exchange !== "BSE_IDX",
    ),
  };
}

// Admin-disabled providers never receive new subscriptions, which also
// means they never get a reason to reconnect - each provider class's own
// reconnect loop is gated on "do I have active subscriptions", so simply
// not routing new symbols to a disabled provider is sufficient here without
// touching any of the three hand-rolled reconnect implementations.
export async function subscribeMarketStreamSymbols(
  symbols: MarketStreamSymbol[],
) {
  const { nse, globalDatafeeds, other } = splitByProvider(symbols);
  logger.info(
    {
      total: symbols.length,
      nse: nse.length,
      globalDatafeeds: globalDatafeeds.length,
      other: other.length,
      sample: symbols.slice(0, 5),
    },
    "Market stream subscribe",
  );

  const [eodhdEnabled, kiteEnabled, globalDatafeedsEnabled] = await Promise.all(
    [
      isProviderEnabled(DATA_PROVIDER_KEY.eodhd),
      isProviderEnabled(DATA_PROVIDER_KEY.zerodha),
      isProviderEnabled(DATA_PROVIDER_KEY.globalDatafeeds),
    ],
  );

  if (other.length > 0) {
    if (eodhdEnabled) eodhdProvider.subscribe(other);
    else
      logger.debug(
        { symbolCount: other.length },
        "Realtime subscribe skipped: EODHD disabled",
      );
  }
  if (nse.length > 0) {
    if (kiteEnabled) void kiteProvider.subscribe(nse);
    else
      logger.debug(
        { symbolCount: nse.length },
        "Realtime subscribe skipped: Zerodha disabled",
      );
  }
  if (globalDatafeeds.length > 0) {
    if (globalDatafeedsEnabled)
      void globalDatafeedsProvider.subscribe(globalDatafeeds);
    else
      logger.debug(
        { symbolCount: globalDatafeeds.length },
        "Realtime subscribe skipped: Global DataFeeds disabled",
      );
  }
}

export function closeMarketStreamProviderByKey(providerKey: string) {
  if (providerKey === DATA_PROVIDER_KEY.eodhd) eodhdProvider.close();
  else if (providerKey === DATA_PROVIDER_KEY.zerodha) kiteProvider.close();
  else if (providerKey === DATA_PROVIDER_KEY.globalDatafeeds)
    globalDatafeedsProvider.close();
}

export function unsubscribeMarketStreamSymbols(symbols: MarketStreamSymbol[]) {
  const { nse, globalDatafeeds, other } = splitByProvider(symbols);
  if (other.length > 0) eodhdProvider.unsubscribe(other);
  if (nse.length > 0) kiteProvider.unsubscribe(nse);
  if (globalDatafeeds.length > 0)
    globalDatafeedsProvider.unsubscribe(globalDatafeeds);
}

export function closeMarketStreamProviders() {
  eodhdProvider.close();
  kiteProvider.close();
  globalDatafeedsProvider.close();
}
