import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { dataProviderConnections } from "../../db/schema";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import { DATA_PROVIDER_KEY, PROVIDER_STATUS, type ProviderCapability } from "../../shared/constants";
import { badRequest, notFound } from "../../shared/errors";
import { decryptField, encryptField } from "../security/encryption";
import {
  adapterSupportsCapability,
  getCandidateProviderKeysForExchange,
  getConnectableDataProviderAdapter,
  getDataProviderAdapterByProvider,
  getDataProviderAdapterForExchange,
  getEodhdDataProviderAdapter,
  listDataProviderAdapters,
} from "./data-provider.registry";
import {
  getProviderPriority,
  isProviderEnabled,
  recordProviderFailure,
  recordProviderSuccess,
} from "./data-provider-settings.service";
import type { DataProviderAdapter, ProviderConnectionStatus } from "./data-provider.types";

export { getDataProviderAdapterForExchange, getEodhdDataProviderAdapter };

const PROVIDER_READY_CACHE_TTL_MS = 15_000;

// isConfigured() alone (env-key presence) is enough for non-OAuth providers,
// but Zerodha requiresConnection - a present API key doesn't mean there's a
// live, unexpired access token, so a real usability check needs the same
// connection-state read getProviderStatus already does. Cached briefly so
// this doesn't add a DB round trip to every single NSE candle request on
// top of the one getActiveProviderAccessToken already does downstream.
async function isProviderReadyToUse(adapter: DataProviderAdapter): Promise<boolean> {
  if (!adapter.isConfigured()) return false;
  if (!adapter.requiresConnection) return true;

  return getOrSetCache(
    `providerEligibility:ready:${adapter.providerKey}`,
    PROVIDER_READY_CACHE_TTL_MS,
    async () => {
      const status = await getProviderStatus(adapter.providerKey);
      return status.connected;
    }
  );
}

// The one place that answers "which providers can actually be used right
// now for this exchange+capability" - admin enabled state, real
// configuration/connection readiness, and capability support all gated
// together, ordered by admin-configured priority. Today's routing table is
// 1:1 (see getCandidateProviderKeysForExchange), so this almost always
// returns 0 or 1 adapters - but every caller goes through this instead of
// the raw registry lookup, so a future second candidate needs no call-site
// changes.
export async function resolveEligibleProviders(input: {
  exchange: string;
  capability: ProviderCapability;
}): Promise<DataProviderAdapter[]> {
  const candidateKeys = getCandidateProviderKeysForExchange(input.exchange);

  const candidates = await Promise.all(
    candidateKeys.map(async (key) => {
      const adapter = getDataProviderAdapterByProvider(key);
      if (!adapter) return null;
      if (!adapterSupportsCapability(adapter, input.capability)) return null;

      const [enabled, ready, priority] = await Promise.all([
        isProviderEnabled(key),
        isProviderReadyToUse(adapter),
        getProviderPriority(key),
      ]);
      if (!enabled || !ready) return null;

      return { adapter, priority };
    })
  );

  return candidates
    .filter((candidate): candidate is { adapter: DataProviderAdapter; priority: number } =>
      candidate !== null
    )
    .sort((a, b) => a.priority - b.priority)
    .map((candidate) => candidate.adapter);
}

export async function getEligibleProviderAdapter(input: {
  exchange: string;
  capability: ProviderCapability;
}): Promise<DataProviderAdapter | null> {
  const eligible = await resolveEligibleProviders(input);
  return eligible[0] ?? null;
}

export function getDataProviderAdapter() {
  return getDataProviderAdapterForExchange();
}

// This is the same live/real connectivity check the admin "Data Providers"
// page's per-provider status panels use (checkConnection() ping for
// non-OAuth providers, stored OAuth connection state for Zerodha) - it's
// the most accurate signal this codebase has for "is this provider
// actually working right now." Feeding it into the throttled
// recordProviderSuccess/recordProviderFailure health tracker means the
// admin table's Health column reflects real status even for providers
// that haven't happened to serve a scanner request recently (recordHealth
// itself is still throttled per key, so viewing this page repeatedly
// doesn't spam data_provider_settings writes).
async function recordStatusHealth(
  providerKey: string,
  result: ProviderConnectionStatus
): Promise<ProviderConnectionStatus> {
  if (result.connected) {
    void recordProviderSuccess(providerKey);
  } else if (result.errorMessage) {
    void recordProviderFailure(providerKey, result.errorMessage);
  }
  return result;
}

export async function getProviderStatus(
  provider: string = DATA_PROVIDER_KEY.zerodha
): Promise<ProviderConnectionStatus> {
  const adapter = getDataProviderAdapterByProvider(provider);
  if (!adapter) throw notFound("Data provider not found");

  const [connection] = await db
    .select()
    .from(dataProviderConnections)
    .where(eq(dataProviderConnections.provider, adapter.providerKey))
    .orderBy(desc(dataProviderConnections.createdAt))
    .limit(1);

  const providerConfigured = adapter.isConfigured();
  const lastSyncedAt = connection?.lastSyncedAt?.toISOString() ?? null;

  if (!adapter.requiresConnection) {
    if (!providerConfigured) {
      return recordStatusHealth(adapter.providerKey, {
        providerConfigured,
        connected: false,
        status: PROVIDER_STATUS.disconnected,
        lastSyncedAt,
        errorMessage: connection?.errorMessage ?? null,
      });
    }

    const health = adapter.checkConnection
      ? await adapter.checkConnection()
      : {
          connected: true,
          status: PROVIDER_STATUS.connected,
          errorMessage: null,
        };

    return recordStatusHealth(adapter.providerKey, {
      providerConfigured,
      connected: health.connected,
      status: health.status,
      lastSyncedAt,
      errorMessage: health.errorMessage ?? connection?.errorMessage ?? null,
    });
  }

  if (!providerConfigured) {
    return recordStatusHealth(adapter.providerKey, {
      providerConfigured,
      connected: false,
      status: PROVIDER_STATUS.disconnected,
      lastSyncedAt,
      errorMessage: connection?.errorMessage ?? null,
    });
  }

  if (connection?.expiresAt && connection.expiresAt.getTime() <= Date.now()) {
    if (connection.status === PROVIDER_STATUS.connected) {
      await db
        .update(dataProviderConnections)
        .set({
          status: PROVIDER_STATUS.expired,
          errorMessage: "Provider access token expired",
          updatedAt: new Date(),
        })
        .where(eq(dataProviderConnections.id, connection.id));
    }

    return recordStatusHealth(adapter.providerKey, {
      providerConfigured,
      connected: false,
      status: PROVIDER_STATUS.expired,
      lastSyncedAt,
      errorMessage: connection.errorMessage ?? "Provider access token expired",
    });
  }

  return recordStatusHealth(adapter.providerKey, {
    providerConfigured,
    connected: connection?.status === PROVIDER_STATUS.connected,
    status: connection?.status ?? PROVIDER_STATUS.disconnected,
    lastSyncedAt,
    errorMessage: connection?.errorMessage ?? null,
  });
}

export async function markProviderConnectionExpired(provider: string, message?: string) {
  const [connection] = await db
    .select()
    .from(dataProviderConnections)
    .where(eq(dataProviderConnections.provider, provider))
    .orderBy(desc(dataProviderConnections.createdAt))
    .limit(1);

  if (!connection || connection.status !== PROVIDER_STATUS.connected) return;

  await db
    .update(dataProviderConnections)
    .set({
      status: PROVIDER_STATUS.expired,
      errorMessage: message ?? "Provider rejected the stored access token",
      updatedAt: new Date(),
    })
    .where(eq(dataProviderConnections.id, connection.id));
  invalidateCacheByPrefix("providerEligibility");
}

export async function getAllProviderStatuses() {
  const statuses = await Promise.all(
    listDataProviderAdapters().map(async (adapter) => ({
      provider: adapter.providerKey,
      ...(await getProviderStatus(adapter.providerKey)),
    }))
  );

  return { providers: statuses };
}

export function getProviderConnectUrl() {
  return getConnectableDataProviderAdapter().getConnectUrl();
}

export async function saveProviderToken(input: {
  requestToken: string;
  provider?: string;
}) {
  const adapter = input.provider
    ? getDataProviderAdapterByProvider(input.provider)
    : getConnectableDataProviderAdapter();

  if (!adapter) throw notFound("Data provider not found");
  if (!adapter.requiresConnection) {
    throw badRequest("Selected data provider uses server-side API credentials");
  }

  const tokenData = await adapter.exchangeRequestToken(input.requestToken);

  const [connection] = await db
    .insert(dataProviderConnections)
    .values({
      provider: adapter.providerKey,
      status: PROVIDER_STATUS.connected,
      encryptedAccessToken: encryptField(tokenData.accessToken),
      encryptedRefreshToken: tokenData.refreshToken
        ? encryptField(tokenData.refreshToken)
        : null,
      encryptedAccountId: tokenData.accountId ? encryptField(tokenData.accountId) : null,
      expiresAt: tokenData.expiresAt,
    })
    .returning();

  invalidateCacheByPrefix("providerEligibility");
  return connection;
}

export async function getActiveProviderAccessToken(provider: string) {
  const adapter = getDataProviderAdapterByProvider(provider);
  if (!adapter) throw notFound("Data provider not found");
  if (!adapter.requiresConnection) return undefined;

  const [connection] = await db
    .select()
    .from(dataProviderConnections)
    .where(
      and(
        eq(dataProviderConnections.provider, adapter.providerKey),
        eq(dataProviderConnections.status, PROVIDER_STATUS.connected)
      )
    )
    .orderBy(desc(dataProviderConnections.createdAt))
    .limit(1);

if (!connection?.encryptedAccessToken) {
    throw notFound("Data provider is not connected");
  }

  if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) {
    await markProviderConnectionExpired(adapter.providerKey, "Provider access token expired");
    throw notFound("Data provider token expired");
  }

  return decryptField(connection.encryptedAccessToken);
}
