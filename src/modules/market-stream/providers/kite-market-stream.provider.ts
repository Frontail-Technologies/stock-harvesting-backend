import { and, eq } from "drizzle-orm";
import WebSocket from "ws";

import { db } from "../../../db/client";
import { instruments } from "../../../db/schema";
import { DATA_PROVIDER_KEY } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { logger } from "../../../shared/logger";
import { getActiveProviderAccessToken } from "../../data-provider/data-provider.service";
import { applyTickToCandles } from "../market-stream-candles";
import { publishMarketStreamEvent } from "../market-stream.hub";
import type { MarketStreamSymbol } from "../market-stream.types";

const KITE_WS_URL = "wss://ws.kite.trade";
const PRICE_DIVISOR = 100;

type KiteSubscription = MarketStreamSymbol & {
  instrumentToken: number;
};

export class KiteMarketStreamProvider {
  private socket: WebSocket | null = null;
  private subscriptions = new Map<string, KiteSubscription>();
  private tokenToSymbol = new Map<number, KiteSubscription>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private missingTokenWarnings = new Set<string>();

  async subscribe(symbols: MarketStreamSymbol[]) {
    const nseSymbols = symbols.filter((symbol) => symbol.exchange === "NSE");
    if (nseSymbols.length === 0) return;

    const resolved = await this.resolveSubscriptions(nseSymbols);
    for (const item of resolved) {
      this.subscriptions.set(item.symbol, item);
      this.tokenToSymbol.set(item.instrumentToken, item);
    }

    await this.connect();
    this.sendSubscriptions(resolved.map((item) => item.instrumentToken));
  }

  unsubscribe(symbols: MarketStreamSymbol[]) {
    const tokens: number[] = [];
    for (const symbol of symbols) {
      if (symbol.exchange !== "NSE") continue;
      const existing = this.subscriptions.get(symbol.symbol);
      if (!existing) continue;
      this.subscriptions.delete(symbol.symbol);
      this.tokenToSymbol.delete(existing.instrumentToken);
      tokens.push(existing.instrumentToken);
    }

    if (tokens.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ a: "unsubscribe", v: tokens }));
    }
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private async connect() {
    if (this.socket || this.connecting) return;
    if (!env.ZERODHA_API_KEY) return;

    this.connecting = true;
    let accessToken: string | undefined;
    try {
      accessToken = await getActiveProviderAccessToken(DATA_PROVIDER_KEY.zerodha);
    } catch (error) {
      this.connecting = false;
      logger.warn(
        {
          provider: DATA_PROVIDER_KEY.zerodha,
          message: error instanceof Error ? error.message : "Unable to load access token",
        },
        "Kite market stream not connected"
      );
      return;
    }
    if (!accessToken) {
      this.connecting = false;
      return;
    }

    const url = new URL(KITE_WS_URL);
    url.searchParams.set("api_key", env.ZERODHA_API_KEY);
    url.searchParams.set("access_token", accessToken);
    this.socket = new WebSocket(url.toString());

    this.socket.on("open", () => {
      this.connecting = false;
      publishMarketStreamEvent({
        type: "market.provider.status",
        data: {
          provider: "kite",
          connected: true,
          exchange: "NSE",
          time: new Date().toISOString(),
        },
      });
      const tokens = [...this.tokenToSymbol.keys()];
      this.sendSubscriptions(tokens);
    });

    this.socket.on("message", (raw) => {
      if (!Buffer.isBuffer(raw)) return;
      this.handleBinaryMessage(raw);
    });

    this.socket.on("close", () => {
      this.connecting = false;
      this.socket = null;
      publishMarketStreamEvent({
        type: "market.provider.status",
        data: {
          provider: "kite",
          connected: false,
          exchange: "NSE",
          time: new Date().toISOString(),
        },
      });
      if (this.subscriptions.size > 0) {
        this.reconnectTimer = setTimeout(() => void this.connect(), 3000);
      }
    });

    this.socket.on("error", (error) => {
      logger.warn(
        { provider: DATA_PROVIDER_KEY.zerodha, message: error.message },
        "Kite market stream error"
      );
    });
  }

  private sendSubscriptions(tokens: number[]) {
    if (tokens.length === 0 || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ a: "subscribe", v: tokens }));
    this.socket.send(JSON.stringify({ a: "mode", v: ["quote", tokens] }));
  }

  private handleBinaryMessage(buffer: Buffer) {
    if (buffer.length <= 2) return;

    const packetCount = buffer.readInt16BE(0);
    let offset = 2;

    for (let index = 0; index < packetCount; index++) {
      if (offset + 2 > buffer.length) return;
      const packetLength = buffer.readInt16BE(offset);
      offset += 2;
      if (offset + packetLength > buffer.length) return;

      this.handlePacket(buffer.subarray(offset, offset + packetLength));
      offset += packetLength;
    }
  }

  private handlePacket(packet: Buffer) {
    if (packet.length < 8) return;

    const instrumentToken = packet.readInt32BE(0);
    const subscription = this.tokenToSymbol.get(instrumentToken);
    if (!subscription) return;

    const price = packet.readInt32BE(4) / PRICE_DIVISOR;
    const volume = packet.length >= 20 ? packet.readInt32BE(16) : undefined;
    const exchangeTimestampSeconds = packet.length >= 64 ? packet.readInt32BE(60) : undefined;
    const time = new Date(
      exchangeTimestampSeconds ? exchangeTimestampSeconds * 1000 : Date.now()
    ).toISOString();
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
    for (const candleEvent of applyTickToCandles(tick)) {
      publishMarketStreamEvent(candleEvent);
    }
  }

  private async resolveSubscriptions(symbols: MarketStreamSymbol[]) {
    const resolved: KiteSubscription[] = [];

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

      const instrumentToken = Number(instrument?.instrumentToken);
      if (!Number.isFinite(instrumentToken)) {
        const warningKey = `${symbol.exchange}:${symbol.symbol}`;
        if (!this.missingTokenWarnings.has(warningKey)) {
          this.missingTokenWarnings.add(warningKey);
          logger.warn(
            {
              exchange: symbol.exchange,
              symbol: symbol.symbol,
              provider: instrument?.provider,
            },
            "Kite stream instrument token not found"
          );
        }
        continue;
      }

      resolved.push({ ...symbol, instrumentToken });
    }

    return resolved;
  }
}
