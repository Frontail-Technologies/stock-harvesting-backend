import { DATA_PROVIDER_KEY } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { getErrorMessage } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
import {
  GLOBAL_DATAFEEDS_MESSAGE_TYPE,
  GLOBAL_DATAFEEDS_SNAPSHOT_PERIOD,
  GLOBAL_DATAFEEDS_SNAPSHOT_PERIODICITY,
} from "../../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import type { GlobalDatafeedsQuoteRow } from "../../data-provider/adapters/global-datafeeds/global-datafeeds.types";
import { globalDatafeedsClient } from "../../data-provider/adapters/global-datafeeds/global-datafeeds.websocket-client";
import { resolveInstrumentsForSymbols } from "../../market-data/market-data.instruments";
import { applyProviderDailyCandle } from "../market-stream-candles";
import {
  isFunctionNotEnabledMessage,
  isProviderCapabilityCoolingDown,
  markProviderCapabilityAvailable,
  markProviderCapabilityUnavailable,
} from "../market-stream.capabilities";
import { publishMarketStreamEvent } from "../market-stream.hub";
import { updateProviderConnection, updateProviderLastMessage } from "../market-stream.provider-health";
import { streamSymbolKey } from "../market-stream.utils";
import type { MarketStreamSymbol } from "../market-stream.types";

type GlobalDatafeedsSubscription = MarketStreamSymbol & {
  instrumentIdentifier: string;
};

function isGlobalDatafeedsExchange(exchange: string) {
  return exchange === "BSE" || exchange === "BSE_IDX";
}

function toFiniteNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function toIsoTime(value: unknown) {
  const numericTime = Number(value);
  if (!Number.isFinite(numericTime) || numericTime <= 0) {
    return new Date().toISOString();
  }

  return new Date(numericTime > 1_000_000_000_000 ? numericTime : numericTime * 1000).toISOString();
}

export class GlobalDatafeedsMarketStreamProvider {
  private subscriptions = new Map<string, GlobalDatafeedsSubscription>();
  private identifierToSymbol = new Map<string, GlobalDatafeedsSubscription>();
  private missingTokenWarnings = new Set<string>();
  private quoteLogCount = 0;
  private removeQuoteListener = globalDatafeedsClient.addQuoteListener((quote) => {
    this.handleQuote(quote);
  });
  private removeDebugListener = globalDatafeedsClient.addDebugListener((event) => {
    const payload = event.payload as { Message?: unknown } | undefined;
    const message = event.message ?? (typeof payload?.Message === "string" ? payload.Message : undefined);
    if (isFunctionNotEnabledMessage(message)) {
      markProviderCapabilityUnavailable({
        provider: DATA_PROVIDER_KEY.globalDatafeeds,
        exchange: "BSE",
        reason: message ?? "Function not enabled",
      });
    }
    if (
      event.stage === "response.unmatched" ||
      event.stage === "request.timeout" ||
      event.stage === "socket.error" ||
      event.stage === "socket.close"
    ) {
      logger.warn(
        {
          stage: event.stage,
          messageType: event.messageType,
          message: event.message,
          payload: event.payload,
        },
        "Global Datafeeds stream provider debug"
      );
    }
  });
  private removeStatusListener = globalDatafeedsClient.addStatusListener((connected, message) => {
    updateProviderConnection({
      provider: DATA_PROVIDER_KEY.globalDatafeeds,
      connected,
      exchange: "BSE",
      message,
    });
    publishMarketStreamEvent({
      type: "market.provider.status",
      data: {
        provider: DATA_PROVIDER_KEY.globalDatafeeds,
        connected,
        exchange: "BSE",
        message,
        time: new Date().toISOString(),
      },
    });
  });

  async subscribe(symbols: MarketStreamSymbol[]) {
    const requestedSymbols = symbols.filter((symbol) =>
      isGlobalDatafeedsExchange(symbol.exchange)
    );
    if (requestedSymbols.length === 0) return;
    if (isProviderCapabilityCoolingDown(DATA_PROVIDER_KEY.globalDatafeeds, "BSE")) {
      logger.info(
        {
          provider: DATA_PROVIDER_KEY.globalDatafeeds,
          requested: requestedSymbols.length,
        },
        "Global Datafeeds stream subscribe skipped: current-day capability unavailable"
      );
      return;
    }

    let resolved: GlobalDatafeedsSubscription[];
    try {
      resolved = await this.resolveSubscriptions(requestedSymbols);
    } catch (error) {
      logger.warn(
        {
          provider: DATA_PROVIDER_KEY.globalDatafeeds,
          requested: requestedSymbols.length,
          message: getErrorMessage(error, "Unknown instrument resolution error"),
        },
        "Global Datafeeds stream subscribe failed to resolve instruments"
      );
      return;
    }

    const capacity = Math.max(0, env.GLOBAL_DATAFEEDS_SYMBOL_LIMIT - this.subscriptions.size);
    const added: GlobalDatafeedsSubscription[] = [];

    logger.info(
      {
        requested: requestedSymbols.length,
        resolved: resolved.length,
        existing: this.subscriptions.size,
        capacity,
        sample: resolved.slice(0, 5).map((item) => ({
          exchange: item.exchange,
          symbol: item.symbol,
          instrumentIdentifier: item.instrumentIdentifier,
        })),
      },
      "Global Datafeeds stream subscribe resolved"
    );

    for (const item of resolved) {
      const key = streamSymbolKey(item);
      if (this.subscriptions.has(key)) continue;
      if (added.length >= capacity) continue;
      this.subscriptions.set(key, item);
      this.identifierToSymbol.set(this.identifierKey(item.exchange, item.instrumentIdentifier), item);
      await this.sendSubscription(item, false);
      added.push(item);
    }

    if (added.length > 0) {
      logger.info(
        {
          added: added.length,
          sample: added.slice(0, 5).map((item) => ({
            exchange: item.exchange,
            symbol: item.symbol,
            instrumentIdentifier: item.instrumentIdentifier,
          })),
        },
        "Global Datafeeds stream subscribed"
      );
    }
  }

  unsubscribe(symbols: MarketStreamSymbol[]) {
    for (const symbol of symbols) {
      if (!isGlobalDatafeedsExchange(symbol.exchange)) continue;
      const key = streamSymbolKey(symbol);
      const existing = this.subscriptions.get(key);
      if (!existing) continue;
      this.subscriptions.delete(key);
      this.identifierToSymbol.delete(
        this.identifierKey(existing.exchange, existing.instrumentIdentifier)
      );
      void this.sendSubscription(existing, true);
    }
  }

  close() {
    this.removeQuoteListener();
    this.removeDebugListener();
    this.removeStatusListener();
    globalDatafeedsClient.close();
  }

  private async sendSubscription(
    subscription: GlobalDatafeedsSubscription,
    unsubscribe: boolean
  ) {
    try {
      await globalDatafeedsClient.send({
        MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.subscribeSnapshot,
        Exchange: subscription.exchange,
        InstrumentIdentifier: subscription.instrumentIdentifier,
        Periodicity: GLOBAL_DATAFEEDS_SNAPSHOT_PERIODICITY,
        Period: GLOBAL_DATAFEEDS_SNAPSHOT_PERIOD,
        Unsubscribe: unsubscribe ? "true" : "false",
      });
    } catch (error) {
      logger.warn(
        {
          provider: DATA_PROVIDER_KEY.globalDatafeeds,
          exchange: subscription.exchange,
          symbol: subscription.symbol,
          message: getErrorMessage(error, "Unknown stream error"),
        },
        "Global Datafeeds subscription failed"
      );
    }
  }

  private handleQuote(quote: GlobalDatafeedsQuoteRow) {
    const exchange = quote.Exchange?.trim().toUpperCase();
    const identifier = quote.InstrumentIdentifier?.trim().toUpperCase();
    const price = toFiniteNumber(quote.LastTradePrice) ?? toFiniteNumber(quote.Close);
    if (!exchange || !identifier || price === undefined) {
      logger.debug(
        {
          messageType: quote.MessageType,
          exchange,
          identifier,
          hasPrice: price !== undefined,
          keys: Object.keys(quote).slice(0, 20),
        },
        "Global Datafeeds quote skipped"
      );
      return;
    }

    const subscription = this.identifierToSymbol.get(this.identifierKey(exchange, identifier));
    if (!subscription) {
      logger.debug(
        {
          exchange,
          identifier,
          price,
        },
        "Global Datafeeds quote unmatched"
      );
      return;
    }

    if (this.quoteLogCount < 5) {
      this.quoteLogCount += 1;
      logger.info(
        {
          messageType: quote.MessageType,
          exchange,
          identifier,
          symbol: subscription.symbol,
          price,
          volume:
            toFiniteNumber(quote.TotalQtyTraded) ?? toFiniteNumber(quote.TradedQty),
        },
        "Global Datafeeds quote received"
      );
    }

    const time = toIsoTime(quote.LastTradeTime ?? quote.ServerTime);
    const volume = toFiniteNumber(quote.TotalQtyTraded) ?? toFiniteNumber(quote.TradedQty);
    updateProviderLastMessage({
      provider: DATA_PROVIDER_KEY.globalDatafeeds,
      exchange: subscription.exchange,
      time,
    });
    const tick = {
      exchange: subscription.exchange,
      symbol: subscription.symbol,
      price,
      volume,
      time,
    };

    publishMarketStreamEvent({
      type: "market.tick",
      data: tick,
    });
    markProviderCapabilityAvailable(DATA_PROVIDER_KEY.globalDatafeeds, subscription.exchange);
    logger.debug(
      {
        exchange: subscription.exchange,
        symbol: subscription.symbol,
        price,
        volume,
      },
      "Global Datafeeds tick published"
    );

    const open = toFiniteNumber(quote.Open);
    const high = toFiniteNumber(quote.High);
    const low = toFiniteNumber(quote.Low);
    if (open !== undefined && high !== undefined && low !== undefined) {
      const candleEvent = applyProviderDailyCandle({
          exchange: subscription.exchange,
          symbol: subscription.symbol,
          time,
          open,
          high,
          low,
          close: price,
          volume,
      });
      if (candleEvent) publishMarketStreamEvent(candleEvent);
    }
  }

  private async resolveSubscriptions(symbols: MarketStreamSymbol[]) {
    const resolved: GlobalDatafeedsSubscription[] = [];
    const instrumentsByKey = await resolveInstrumentsForSymbols(symbols);

    for (const symbol of symbols) {
      const instrument = instrumentsByKey.get(streamSymbolKey(symbol));
      const instrumentIdentifier = instrument?.instrumentToken || symbol.symbol;
      if (!instrumentIdentifier) {
        const warningKey = streamSymbolKey(symbol);
        if (!this.missingTokenWarnings.has(warningKey)) {
          this.missingTokenWarnings.add(warningKey);
          logger.warn(
            {
              exchange: symbol.exchange,
              symbol: symbol.symbol,
              provider: instrument?.provider,
            },
            "Global Datafeeds stream instrument token not found"
          );
        }
        continue;
      }

      resolved.push({
        ...symbol,
        instrumentIdentifier,
      });
    }

    return resolved;
  }

  private identifierKey(exchange: string, identifier: string) {
    return `${exchange.trim().toUpperCase()}:${identifier.trim().toUpperCase()}`;
  }
}
