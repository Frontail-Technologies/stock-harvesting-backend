import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { dataProviderConnections } from "../../db/schema";
import { DATA_PROVIDER_KEY, PROVIDER_STATUS } from "../../shared/constants";
import { badRequest, notFound } from "../../shared/errors";
import { decryptField, encryptField } from "../security/encryption";
import {
  getConnectableDataProviderAdapter,
  getDataProviderAdapterByProvider,
  getDataProviderAdapterForExchange,
  getEodhdDataProviderAdapter,
  listDataProviderAdapters,
} from "./data-provider.registry";
import type { DataProviderAdapter, ProviderConnectionStatus } from "./data-provider.types";

export { getDataProviderAdapterForExchange, getEodhdDataProviderAdapter };

export function getDataProviderAdapter() {
  return getDataProviderAdapterForExchange();
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
      return {
        providerConfigured,
        connected: false,
        status: PROVIDER_STATUS.disconnected,
        lastSyncedAt,
        errorMessage: connection?.errorMessage ?? null,
      };
    }

    const health = adapter.checkConnection
      ? await adapter.checkConnection()
      : {
          connected: true,
          status: PROVIDER_STATUS.connected,
          errorMessage: null,
        };

    return {
      providerConfigured,
      connected: health.connected,
      status: health.status,
      lastSyncedAt,
      errorMessage: health.errorMessage ?? connection?.errorMessage ?? null,
    };
  }

  if (!providerConfigured) {
    return {
      providerConfigured,
      connected: false,
      status: PROVIDER_STATUS.disconnected,
      lastSyncedAt,
      errorMessage: connection?.errorMessage ?? null,
    };
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

    return {
      providerConfigured,
      connected: false,
      status: PROVIDER_STATUS.expired,
      lastSyncedAt,
      errorMessage: connection.errorMessage ?? "Provider access token expired",
    };
  }

  return {
    providerConfigured,
    connected: connection?.status === PROVIDER_STATUS.connected,
    status: connection?.status ?? PROVIDER_STATUS.disconnected,
    lastSyncedAt,
    errorMessage: connection?.errorMessage ?? null,
  };
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
