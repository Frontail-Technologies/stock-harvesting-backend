import type WebSocket from "ws";

import type {
  MarketStreamEvent,
  MarketStreamServerMessage,
  MarketStreamSymbol,
  MarketStreamUser,
} from "./market-stream.types";
import { evaluatePriceAlertsForQuote } from "../price-alerts/price-alerts.service";
import { normalizeStreamSymbol, streamSymbolKey } from "./market-stream.utils";

type Client = {
  socket: WebSocket;
  user: MarketStreamUser;
  subscriptions: Map<string, MarketStreamSymbol>;
};

type RegisterClientOptions = {
  onSubscribe?: (symbols: MarketStreamSymbol[]) => void;
  onUnsubscribe?: (symbols: MarketStreamSymbol[]) => void;
};

const clients = new Set<Client>();

function send(socket: WebSocket, message: MarketStreamServerMessage) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function getMatchingClients(event: MarketStreamEvent) {
  if (!("exchange" in event.data) || !("symbol" in event.data)) {
    return [...clients];
  }

  const key = streamSymbolKey({
    exchange: event.data.exchange,
    symbol: event.data.symbol,
  });

  return [...clients].filter((client) => client.subscriptions.has(key));
}

export function registerMarketStreamClient(
  socket: WebSocket,
  user: MarketStreamUser,
  options: RegisterClientOptions = {}
) {
  const client: Client = {
    socket,
    user,
    subscriptions: new Map(),
  };

  clients.add(client);
  send(socket, {
    type: "connection.ready",
    data: {
      userId: user.id,
      time: new Date().toISOString(),
    },
  });

  socket.on("close", () => {
    const removed = [...client.subscriptions.values()];
    clients.delete(client);
    if (removed.length > 0) options.onUnsubscribe?.(removed);
  });

  return {
    subscribe(symbols: MarketStreamSymbol[]) {
      const added: MarketStreamSymbol[] = [];
      for (const symbol of symbols) {
        const normalized = normalizeStreamSymbol(symbol);
        if (!normalized) continue;
        const key = streamSymbolKey(normalized);
        if (client.subscriptions.has(key)) continue;
        client.subscriptions.set(key, normalized);
        added.push(normalized);
      }
      if (added.length > 0) options.onSubscribe?.(added);
      send(socket, {
        type: "subscription.updated",
        data: {
          subscriptions: [...client.subscriptions.values()],
          time: new Date().toISOString(),
        },
      });
    },
    unsubscribe(symbols: MarketStreamSymbol[]) {
      const removed: MarketStreamSymbol[] = [];
      for (const symbol of symbols) {
        const normalized = normalizeStreamSymbol(symbol);
        if (!normalized) continue;
        const key = streamSymbolKey(normalized);
        if (!client.subscriptions.has(key)) continue;
        client.subscriptions.delete(key);
        removed.push(normalized);
      }
      if (removed.length > 0) options.onUnsubscribe?.(removed);
      send(socket, {
        type: "subscription.updated",
        data: {
          subscriptions: [...client.subscriptions.values()],
          time: new Date().toISOString(),
        },
      });
    },
    pong() {
      send(socket, {
        type: "pong",
        data: {
          time: new Date().toISOString(),
        },
      });
    },
    error(code: string, message: string) {
      send(socket, {
        type: "error",
        error: {
          code,
          message,
        },
      });
    },
  };
}

export function publishMarketStreamEvent(event: MarketStreamEvent) {
  for (const client of getMatchingClients(event)) {
    send(client.socket, event);
  }
}

export function getMarketStreamStats() {
  let subscriptionCount = 0;
  for (const client of clients) {
    subscriptionCount += client.subscriptions.size;
  }

  return {
    clients: clients.size,
    subscriptions: subscriptionCount,
  };
}
