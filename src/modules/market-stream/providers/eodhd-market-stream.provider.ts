import WebSocket from "ws";

import { DATA_PROVIDER_KEY } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { logger } from "../../../shared/logger";
import { applyTickToCandles } from "../market-stream-candles";
import { publishMarketStreamEvent } from "../market-stream.hub";
import type { MarketStreamSymbol } from "../market-stream.types";

const EODHD_WS_URL = "wss://ws.eodhistoricaldata.com/ws/us";

type EodhdTradeMessage = {
  s?: string;
  p?: number;
  v?: number;
  t?: number;
  status_code?: number;
  message?: string;
};

export class EodhdMarketStreamProvider {
  private socket: WebSocket | null = null;
  private subscriptions = new Map<string, MarketStreamSymbol>();
  private reconnectTimer: NodeJS.Timeout | null = null;

  subscribe(symbols: MarketStreamSymbol[]) {
    for (const symbol of symbols) {
      if (symbol.exchange === "NSE") continue;
      this.subscriptions.set(symbol.symbol, symbol);
    }
    this.connect();
    this.sendSubscriptions();
  }

  unsubscribe(symbols: MarketStreamSymbol[]) {
    for (const symbol of symbols) {
      if (symbol.exchange === "NSE") continue;
      this.subscriptions.delete(symbol.symbol);
    }
    this.sendSubscriptions();
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private connect() {
    if (!env.EODHD_API_TOKEN || this.socket) return;

    const url = new URL(EODHD_WS_URL);
    url.searchParams.set("api_token", env.EODHD_API_TOKEN);
    this.socket = new WebSocket(url.toString());

    this.socket.on("open", () => {
      publishMarketStreamEvent({
        type: "market.provider.status",
        data: {
          provider: DATA_PROVIDER_KEY.eodhd,
          connected: true,
          exchange: "US",
          time: new Date().toISOString(),
        },
      });
      this.sendSubscriptions();
    });

    this.socket.on("message", (raw) => {
      this.handleMessage(raw.toString());
    });

    this.socket.on("close", () => {
      this.socket = null;
      publishMarketStreamEvent({
        type: "market.provider.status",
        data: {
          provider: DATA_PROVIDER_KEY.eodhd,
          connected: false,
          exchange: "US",
          time: new Date().toISOString(),
        },
      });
      if (this.subscriptions.size > 0) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });

    this.socket.on("error", (error) => {
      logger.warn(
        { provider: DATA_PROVIDER_KEY.eodhd, message: error.message },
        "EODHD market stream error"
      );
    });
  }

  private sendSubscriptions() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;

    this.socket.send(
      JSON.stringify({
        action: "subscribe",
        symbols: [...this.subscriptions.keys()].join(","),
      })
    );
  }

  private handleMessage(raw: string) {
    let message: EodhdTradeMessage;
    try {
      message = JSON.parse(raw) as EodhdTradeMessage;
    } catch {
      return;
    }

    if (message.status_code) {
      logger.info(
        { provider: DATA_PROVIDER_KEY.eodhd, statusCode: message.status_code },
        "EODHD market stream status"
      );
      return;
    }

    if (!message.s || typeof message.p !== "number") return;

    const symbol = this.subscriptions.get(message.s);
    if (!symbol) return;

    const time = new Date(message.t ?? Date.now()).toISOString();
    const tick = {
      exchange: symbol.exchange,
      symbol: symbol.symbol,
      price: message.p,
      volume: message.v,
      time,
    };

    publishMarketStreamEvent({
      type: "market.tick",
      data: tick,
    });
    for (const candleEvent of applyTickToCandles(tick)) {
      publishMarketStreamEvent(candleEvent);
    }
  }
}
