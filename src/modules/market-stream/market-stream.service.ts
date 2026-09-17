import { EodhdMarketStreamProvider } from "./providers/eodhd-market-stream.provider";
import { GlobalDatafeedsMarketStreamProvider } from "./providers/global-datafeeds-market-stream.provider";
import { KiteMarketStreamProvider } from "./providers/kite-market-stream.provider";
import type { MarketStreamSymbol } from "./market-stream.types";
import { DATA_PROVIDER_KEY } from "../../shared/constants";
import { logger } from "../../shared/logger";
import { isProviderEnabled } from "../data-provider/data-provider-settings.service";
import { updateProviderSubscriptions } from "./market-stream.provider-health";
import { streamSymbolKey } from "./market-stream.utils";

const eodhdProvider = new EodhdMarketStreamProvider();
const kiteProvider = new KiteMarketStreamProvider();
const globalDatafeedsProvider = new GlobalDatafeedsMarketStreamProvider();
const subscriptionRefs = new Map<string, { symbol: MarketStreamSymbol; count: number }>();
const ensuredSymbols = new Map<string, NodeJS.Timeout>();
const DEFAULT_ENSURE_IDLE_MS = 2 * 60_000;

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

function updateProviderSubscriptionHealth() {
  const active = [...subscriptionRefs.values()].map((entry) => entry.symbol);
  const { nse, globalDatafeeds, other } = splitByProvider(active);
  updateProviderSubscriptions({ provider: DATA_PROVIDER_KEY.eodhd, subscriptions: other });
  updateProviderSubscriptions({ provider: DATA_PROVIDER_KEY.zerodha, subscriptions: nse });
  updateProviderSubscriptions({
    provider: DATA_PROVIDER_KEY.globalDatafeeds,
    exchange: "BSE",
    subscriptions: globalDatafeeds,
  });
}

function retainSymbols(symbols: MarketStreamSymbol[]) {
  const added: MarketStreamSymbol[] = [];
  for (const symbol of symbols) {
    const key = streamSymbolKey(symbol);
    const current = subscriptionRefs.get(key);
    if (current) {
      current.count += 1;
    } else {
      subscriptionRefs.set(key, { symbol, count: 1 });
      added.push(symbol);
    }
  }
  updateProviderSubscriptionHealth();
  return added;
}

function releaseSymbols(symbols: MarketStreamSymbol[]) {
  const removed: MarketStreamSymbol[] = [];
  for (const symbol of symbols) {
    const key = streamSymbolKey(symbol);
    const current = subscriptionRefs.get(key);
    if (!current) continue;
    current.count -= 1;
    if (current.count <= 0) {
      subscriptionRefs.delete(key);
      removed.push(current.symbol);
    }
  }
  updateProviderSubscriptionHealth();
  return removed;
}

// Admin-disabled providers never receive new subscriptions, which also
// means they never get a reason to reconnect - each provider class's own
// reconnect loop is gated on "do I have active subscriptions", so simply
// not routing new symbols to a disabled provider is sufficient here without
// touching any of the three hand-rolled reconnect implementations.
export async function subscribeMarketStreamSymbols(
  symbols: MarketStreamSymbol[],
) {
  const addedSymbols = retainSymbols(symbols);
  await subscribeAddedMarketStreamSymbols(symbols, addedSymbols);
}

async function subscribeAddedMarketStreamSymbols(
  requestedSymbols: MarketStreamSymbol[],
  addedSymbols: MarketStreamSymbol[],
) {
  const { nse, globalDatafeeds, other } = splitByProvider(addedSymbols);
  logger.info(
    {
      total: requestedSymbols.length,
      added: addedSymbols.length,
      nse: nse.length,
      globalDatafeeds: globalDatafeeds.length,
      other: other.length,
      sample: requestedSymbols.slice(0, 5),
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

export async function ensureMarketStreamSymbols(
  symbols: MarketStreamSymbol[],
  idleMs: number = DEFAULT_ENSURE_IDLE_MS,
) {
  const added: MarketStreamSymbol[] = [];
  for (const symbol of symbols) {
    const key = streamSymbolKey(symbol);
    const existingTimer = ensuredSymbols.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    else added.push(...retainSymbols([symbol]));

    const timer = setTimeout(() => {
      ensuredSymbols.delete(key);
      unsubscribeMarketStreamSymbols([symbol]);
    }, idleMs);
    timer.unref?.();
    ensuredSymbols.set(key, timer);
  }
  if (added.length > 0) await subscribeAddedMarketStreamSymbols(symbols, added);
}

export function closeMarketStreamProviderByKey(providerKey: string) {
  if (providerKey === DATA_PROVIDER_KEY.eodhd) eodhdProvider.close();
  else if (providerKey === DATA_PROVIDER_KEY.zerodha) kiteProvider.close();
  else if (providerKey === DATA_PROVIDER_KEY.globalDatafeeds)
    globalDatafeedsProvider.close();
}

export function unsubscribeMarketStreamSymbols(symbols: MarketStreamSymbol[]) {
  const removedSymbols = releaseSymbols(symbols);
  const { nse, globalDatafeeds, other } = splitByProvider(removedSymbols);
  if (other.length > 0) eodhdProvider.unsubscribe(other);
  if (nse.length > 0) kiteProvider.unsubscribe(nse);
  if (globalDatafeeds.length > 0)
    globalDatafeedsProvider.unsubscribe(globalDatafeeds);
}

export function getActiveMarketStreamSubscriptions() {
  return [...subscriptionRefs.values()].map((entry) => ({
    ...entry.symbol,
    count: entry.count,
  }));
}

export function closeMarketStreamProviders() {
  eodhdProvider.close();
  kiteProvider.close();
  globalDatafeedsProvider.close();
}
