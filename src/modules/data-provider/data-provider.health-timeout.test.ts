import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataProviderAdapter, ProviderHealthStatus } from "./data-provider.types";
import {
  checkConnectionWithTimeout,
  PROVIDER_HEALTH_CHECK_TIMEOUT_MS,
} from "./data-provider.service";

// Regression test for the admin "Data Providers" page leaving GlobalDataFeeds /
// EODHD stuck on "Provider config: Checking...". Root cause: getProviderStatus
// awaited a live external checkConnection() (GDF WS ping up to 30s, EODHD HTTP)
// with no bound, so the whole /api/admin/data-provider/statuses response - and
// therefore the query's isLoading - never resolved. checkConnectionWithTimeout
// must always settle to a deterministic ProviderHealthStatus regardless of how
// badly the adapter's own check behaves.

function makeAdapter(
  checkConnection?: DataProviderAdapter["checkConnection"]
): DataProviderAdapter {
  return {
    providerKey: "global-datafeeds",
    requiresConnection: false,
    isConfigured: () => true,
    checkConnection,
    getConnectUrl: () => null,
    exchangeRequestToken: () => {
      throw new Error("not used");
    },
  } as unknown as DataProviderAdapter;
}

describe("checkConnectionWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats an adapter with no checkConnection as connected without an external call", async () => {
    const result = await checkConnectionWithTimeout(makeAdapter(undefined));

    expect(result).toEqual({
      connected: true,
      status: "connected",
      errorMessage: null,
    });
  });

  it("resolves to a timed-out error state when checkConnection hangs indefinitely", async () => {
    vi.useFakeTimers();

    const adapter = makeAdapter(() => new Promise<ProviderHealthStatus>(() => {}));
    const pending = checkConnectionWithTimeout(adapter);

    await vi.advanceTimersByTimeAsync(PROVIDER_HEALTH_CHECK_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({
      connected: false,
      status: "error",
      errorMessage: "Health check timed out",
    });
  });

  it("swallows a rejected checkConnection into a deterministic error state", async () => {
    const adapter = makeAdapter(() => Promise.reject(new Error("WS socket closed")));

    await expect(checkConnectionWithTimeout(adapter)).resolves.toEqual({
      connected: false,
      status: "error",
      errorMessage: "WS socket closed",
    });
  });

  it("passes a fast successful health check straight through", async () => {
    const healthy: ProviderHealthStatus = {
      connected: true,
      status: "connected",
      errorMessage: null,
    };
    const adapter = makeAdapter(() => Promise.resolve(healthy));

    await expect(checkConnectionWithTimeout(adapter)).resolves.toEqual(healthy);
  });
});
