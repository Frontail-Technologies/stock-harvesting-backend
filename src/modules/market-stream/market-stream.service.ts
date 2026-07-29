import { EodhdMarketStreamProvider } from "./providers/eodhd-market-stream.provider";
import { GlobalDatafeedsMarketStreamProvider } from "./providers/global-datafeeds-market-stream.provider";
import { KiteMarketStreamProvider } from "./providers/kite-market-stream.provider";
import type { MarketStreamSymbol } from "./market-stream.types";
import { logger } from "../../shared/logger";

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
      (symbol) => symbol.exchange === "BSE" || symbol.exchange === "BSE_IDX"
    ),
    other: symbols.filter(
      (symbol) =>
        symbol.exchange !== "NSE" &&
        symbol.exchange !== "BSE" &&
        symbol.exchange !== "BSE_IDX"
    ),
  };
}

export function subscribeMarketStreamSymbols(symbols: MarketStreamSymbol[]) {
  const { nse, globalDatafeeds, other } = splitByProvider(symbols);
  logger.info(
    {
      total: symbols.length,
      nse: nse.length,
      globalDatafeeds: globalDatafeeds.length,
      other: other.length,
      sample: symbols.slice(0, 5),
    },
    "Market stream subscribe"
  );
  if (other.length > 0) eodhdProvider.subscribe(other);
  if (nse.length > 0) void kiteProvider.subscribe(nse);
  if (globalDatafeeds.length > 0) void globalDatafeedsProvider.subscribe(globalDatafeeds);
}

export function unsubscribeMarketStreamSymbols(symbols: MarketStreamSymbol[]) {
  const { nse, globalDatafeeds, other } = splitByProvider(symbols);
  if (other.length > 0) eodhdProvider.unsubscribe(other);
  if (nse.length > 0) kiteProvider.unsubscribe(nse);
  if (globalDatafeeds.length > 0) globalDatafeedsProvider.unsubscribe(globalDatafeeds);
}

export function closeMarketStreamProviders() {
  eodhdProvider.close();
  kiteProvider.close();
  globalDatafeedsProvider.close();
}
