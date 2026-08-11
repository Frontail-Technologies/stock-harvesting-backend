import { PROVIDER_STATUS } from "../../shared/constants";
import type { ProviderHealthStatus } from "./data-provider.types";

export function configuredProviderMissing(message = "Provider credentials are not configured"): ProviderHealthStatus {
  return {
    connected: false,
    status: PROVIDER_STATUS.disconnected,
    errorMessage: message,
  };
}

export function configuredProviderConnected(): ProviderHealthStatus {
  return {
    connected: true,
    status: PROVIDER_STATUS.connected,
    errorMessage: null,
  };
}

export function getConfiguredExpiryHealth(
  providerName: string,
  expiresAt?: string
): ProviderHealthStatus | null {
  if (!expiresAt) return null;

  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    return {
      connected: false,
      status: PROVIDER_STATUS.error,
      errorMessage: `${providerName} expiry date is invalid`,
    };
  }

  if (timestamp < Date.now()) {
    return {
      connected: false,
      status: PROVIDER_STATUS.expired,
      errorMessage: `${providerName} credentials expired on ${new Date(timestamp).toISOString().slice(0, 10)}`,
    };
  }

  return null;
}

export function providerHealthFromError(error: unknown): ProviderHealthStatus {
  const message = error instanceof Error ? error.message : "Provider health check failed";
  const lowerMessage = message.toLowerCase();
  const expired = [
    "expired",
    "invalid api",
    "invalid token",
    "invalid key",
    "unauthorized",
    "authentication",
    "access denied",
    "subscription",
    "function not enabled",
    "exchange is disabled",
  ].some((fragment) => lowerMessage.includes(fragment));

  return {
    connected: false,
    status: expired ? PROVIDER_STATUS.expired : PROVIDER_STATUS.error,
    errorMessage: message,
  };
}
