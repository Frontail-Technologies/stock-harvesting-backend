import { and, eq } from "drizzle-orm";

import { db } from "../../../db/client";
import { instruments } from "../../../db/schema";
import { DATA_PROVIDER_KEY } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { getErrorMessage } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
import {
  GLOBAL_DATAFEEDS_MESSAGE_TYPE,
} from "../../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import type { GlobalDatafeedsQuoteRow } from "../../data-provider/adapters/global-datafeeds/global-datafeeds.types";
import { globalDatafeedsClient } from "../../data-provider/adapters/global-datafeeds/global-datafeeds.websocket-client";
import { publishMarketStreamEvent } from "../market-stream.hub";
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

    const resolved = await this.resolveSubscriptions(requestedSymbols);
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
        MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.subscribeRealtime,
        Exchange: subscription.exchange,
        InstrumentIdentifier: subscription.instrumentIdentifier,
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
      publishMarketStreamEvent({
        type: "market.candle.update",
        data: {
          exchange: subscription.exchange,
          symbol: subscription.symbol,
          timeframe: "1D",
          time,
          open,
          high,
          low,
          close: price,
          volume,
        },
      });
    }
  }

  private async resolveSubscriptions(symbols: MarketStreamSymbol[]) {
    const resolved: GlobalDatafeedsSubscription[] = [];

    for (const symbol of symbols) {
      const [instrument] = await db
        .select({
          instrumentToken: instruments.instrumentToken,
          provider: instruments.provider,
        })
        .from(instruments)
        .where(
          and(
            eq(instruments.exchange, symbol.exchange),
            eq(instruments.symbol, symbol.symbol)
          )
        )
        .limit(1);

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
