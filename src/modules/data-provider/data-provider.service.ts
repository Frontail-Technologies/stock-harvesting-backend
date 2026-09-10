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
import type {
  DataProviderAdapter,
  ProviderConnectionStatus,
  ProviderHealthResult,
  ProviderHealthStatus,
  ProviderLocalStatus,
} from "./data-provider.types";

export { getDataProviderAdapterForExchange, getEodhdDataProviderAdapter };

const PROVIDER_READY_CACHE_TTL_MS = 15_000;

// A non-OAuth provider's health check (adapter.checkConnection) makes a live
// external call - GlobalDataFeeds pings its WS GetInstruments (up to a 30s
// client timeout), EODHD fetches sample candles. It is deliberately kept OUT
// of getProviderStatus / getAllProviderLocalStatuses (the admin Data
// Providers page's local "Provider config" / connection / lastSynced rows),
// which must resolve instantly from env + DB. The external check lives only
// in getProviderHealth, called by the page as an independent background
// query. This cap - and the swallowed thrown/rejected check - means a slow,
// dead, or erroring provider surfaces as health status "error" rather than
// hanging that background request.
export const PROVIDER_HEALTH_CHECK_TIMEOUT_MS = 6_000;

export async function checkConnectionWithTimeout(
  adapter: DataProviderAdapter
): Promise<ProviderHealthStatus> {
  if (!adapter.checkConnection) {
    return { connected: true, status: PROVIDER_STATUS.connected, errorMessage: null };
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ProviderHealthStatus>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          connected: false,
          status: PROVIDER_STATUS.error,
          errorMessage: "Health check timed out",
        }),
      PROVIDER_HEALTH_CHECK_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([adapter.checkConnection(), timeout]);
  } catch (error) {
    return {
      connected: false,
      status: PROVIDER_STATUS.error,
      errorMessage: error instanceof Error ? error.message : "Health check failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
function recordProviderHealthObservation(
  providerKey: string,
  observation: Pick<ProviderConnectionStatus, "connected" | "errorMessage">
): void {
  if (observation.connected) {
    void recordProviderSuccess(providerKey);
  } else if (observation.errorMessage) {
    void recordProviderFailure(providerKey, observation.errorMessage);
  }
}

async function recordStatusHealth(
  providerKey: string,
  result: ProviderConnectionStatus
): Promise<ProviderConnectionStatus> {
  recordProviderHealthObservation(providerKey, result);
  return result;
}

// Local/DB-only provider status - makes NO external provider request. For a
// non-OAuth provider (GlobalDataFeeds, EODHD) this is purely env-key presence;
// `connected`/`status` mirror `providerConfigured` because there is no
// connection concept to check without going to the network - real
// reachability is getProviderHealth's job, queried independently by the UI.
// For an OAuth provider (Zerodha) it reads the stored connection row and token
// expiry exactly as before, including the expired-token write-back.
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
    return {
      providerConfigured,
      connected: providerConfigured,
      status: providerConfigured
        ? PROVIDER_STATUS.connected
        : PROVIDER_STATUS.disconnected,
      lastSyncedAt,
      errorMessage: connection?.errorMessage ?? null,
    };
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

// The admin Data Providers page's "local status" query. Every field here is
// env- or DB-derived; NOTHING in this call path touches an external provider
// API, so the whole response resolves in a few ms regardless of whether any
// provider is slow or down. External health is a separate per-provider query
// (getProviderHealth) so one dead provider never delays this or another
// provider's card.
export async function getAllProviderLocalStatuses(): Promise<{
  providers: ProviderLocalStatus[];
}> {
  const providers = await Promise.all(
    listDataProviderAdapters().map(async (adapter): Promise<ProviderLocalStatus> => {
      const [status, enabled, priority] = await Promise.all([
        getProviderStatus(adapter.providerKey),
        isProviderEnabled(adapter.providerKey),
        getProviderPriority(adapter.providerKey),
      ]);

      return {
        provider: adapter.providerKey,
        providerConfigured: status.providerConfigured,
        enabled,
        priority,
        requiresConnection: adapter.requiresConnection,
        connected: status.connected,
        status: status.status,
        lastSyncedAt: status.lastSyncedAt,
        errorMessage: status.errorMessage,
      };
    })
  );

  return { providers };
}

// The external half of the split: runs the provider's own connectivity check,
// bounded by checkConnectionWithTimeout, and feeds the result into the
// throttled health tracker. Called once per provider by an independent
// frontend query so a GlobalDataFeeds timeout can't delay EODHD's card and
// vice versa. For an OAuth provider with no checkConnection() this resolves
// immediately to "connected" (its real connection state is already in the
// local status via the stored token row).
export async function getProviderHealth(provider: string): Promise<ProviderHealthResult> {
  const adapter = getDataProviderAdapterByProvider(provider);
  if (!adapter) throw notFound("Data provider not found");

  const health = await checkConnectionWithTimeout(adapter);
  recordProviderHealthObservation(adapter.providerKey, health);

  return { provider: adapter.providerKey, ...health };
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
