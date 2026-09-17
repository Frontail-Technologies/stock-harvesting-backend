export type MarketStreamCapabilityStatus = "available" | "unavailable" | "unknown";

export type MarketStreamCapabilityState = {
  realtime: MarketStreamCapabilityStatus;
  currentDayCandle: MarketStreamCapabilityStatus;
  completedDailyHistory: MarketStreamCapabilityStatus;
  reason: string | null;
  lastCheckedAt: string | null;
  retryAfter: string | null;
};

const capabilityByProvider = new Map<string, MarketStreamCapabilityState>();
const FUNCTION_NOT_ENABLED_PATTERN = /function not enabled/i;
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;

function defaultState(): MarketStreamCapabilityState {
  return {
    realtime: "unknown",
    currentDayCandle: "unknown",
    completedDailyHistory: "available",
    reason: null,
    lastCheckedAt: null,
    retryAfter: null,
  };
}

function providerKey(provider: string, exchange?: string) {
  return `${provider}:${exchange ?? ""}`;
}

export function getProviderCapabilityState(provider: string, exchange?: string) {
  return capabilityByProvider.get(providerKey(provider, exchange)) ?? defaultState();
}

export function getProviderCapabilityStates() {
  return [...capabilityByProvider.entries()].map(([key, state]) => {
    const [provider, exchange] = key.split(":");
    return { provider, exchange: exchange || undefined, ...state };
  });
}

export function markProviderCapabilityAvailable(provider: string, exchange?: string) {
  const key = providerKey(provider, exchange);
  const current = capabilityByProvider.get(key) ?? defaultState();
  capabilityByProvider.set(key, {
    ...current,
    realtime: "available",
    currentDayCandle: "available",
    reason: null,
    lastCheckedAt: new Date().toISOString(),
    retryAfter: null,
  });
}

export function markProviderCapabilityUnavailable(input: {
  provider: string;
  exchange?: string;
  reason: string;
  cooldownMs?: number;
}) {
  const now = Date.now();
  const cooldownMs = input.cooldownMs ?? UNAVAILABLE_COOLDOWN_MS;
  const current = capabilityByProvider.get(providerKey(input.provider, input.exchange)) ?? defaultState();
  capabilityByProvider.set(providerKey(input.provider, input.exchange), {
    ...current,
    realtime: "unavailable",
    currentDayCandle: "unavailable",
    reason: input.reason,
    lastCheckedAt: new Date(now).toISOString(),
    retryAfter: new Date(now + cooldownMs).toISOString(),
  });
}

export function isProviderCapabilityCoolingDown(provider: string, exchange?: string) {
  const state = getProviderCapabilityState(provider, exchange);
  if (state.realtime !== "unavailable" && state.currentDayCandle !== "unavailable") return false;
  if (!state.retryAfter) return false;
  return new Date(state.retryAfter).getTime() > Date.now();
}

export function isFunctionNotEnabledMessage(value: unknown) {
  return typeof value === "string" && FUNCTION_NOT_ENABLED_PATTERN.test(value);
}
