import type { MarketStreamSymbol } from "./market-stream.types";
import { countCurrentDayCandlesInMemory } from "./market-stream-candles";

export type MarketStreamProviderHealth = {
  provider: string;
  connected: boolean;
  exchange?: string;
  lastMessageTime: string | null;
  activeSubscriptions: number;
  currentDayCandlesInMemory: number;
  lastError: string | null;
};

const healthByProvider = new Map<string, MarketStreamProviderHealth>();

function key(provider: string, exchange?: string) {
  return `${provider}:${exchange ?? ""}`;
}

export function updateProviderConnection(input: {
  provider: string;
  connected: boolean;
  exchange?: string;
  message?: string;
}) {
  const healthKey = key(input.provider, input.exchange);
  const current = healthByProvider.get(healthKey);
  healthByProvider.set(healthKey, {
    provider: input.provider,
    connected: input.connected,
    exchange: input.exchange,
    lastMessageTime: current?.lastMessageTime ?? null,
    activeSubscriptions: current?.activeSubscriptions ?? 0,
    currentDayCandlesInMemory: current?.currentDayCandlesInMemory ?? 0,
    lastError: input.connected ? null : input.message ?? current?.lastError ?? null,
  });
}

export function updateProviderLastMessage(input: { provider: string; exchange?: string; time?: string }) {
  const healthKey = key(input.provider, input.exchange);
  const current = healthByProvider.get(healthKey);
  healthByProvider.set(healthKey, {
    provider: input.provider,
    connected: current?.connected ?? true,
    exchange: input.exchange,
    lastMessageTime: input.time ?? new Date().toISOString(),
    activeSubscriptions: current?.activeSubscriptions ?? 0,
    currentDayCandlesInMemory: current?.currentDayCandlesInMemory ?? 0,
    lastError: current?.lastError ?? null,
  });
}

export function updateProviderSubscriptions(input: {
  provider: string;
  exchange?: string;
  subscriptions: MarketStreamSymbol[];
}) {
  const healthKey = key(input.provider, input.exchange);
  const current = healthByProvider.get(healthKey);
  healthByProvider.set(healthKey, {
    provider: input.provider,
    connected: current?.connected ?? false,
    exchange: input.exchange,
    lastMessageTime: current?.lastMessageTime ?? null,
    activeSubscriptions: input.subscriptions.length,
    currentDayCandlesInMemory: current?.currentDayCandlesInMemory ?? 0,
    lastError: current?.lastError ?? null,
  });
}

export function getMarketStreamProviderHealth() {
  return [...healthByProvider.values()]
    .map((health) => ({
      ...health,
      currentDayCandlesInMemory: countCurrentDayCandlesInMemory(health.exchange),
    }))
    .sort((a, b) =>
      `${a.provider}:${a.exchange ?? ""}`.localeCompare(`${b.provider}:${b.exchange ?? ""}`)
    );
}
