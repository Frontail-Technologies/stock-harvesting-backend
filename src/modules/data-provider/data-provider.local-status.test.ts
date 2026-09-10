import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The admin "Data Providers" page splits LOCAL status (env + DB, must be
// instant) from EXTERNAL health (adapter.checkConnection, bounded, background).
// These tests lock that split in:
//   - getProviderStatus / getAllProviderLocalStatuses never call
//     adapter.checkConnection()
//   - getProviderHealth is the only path that does, and it stays bounded and
//     per-provider isolated
//   - Zerodha's OAuth/DB-derived connection semantics are unchanged

const h = vi.hoisted(() => {
  type FakeAdapter = {
    providerKey: string;
    requiresConnection: boolean;
    isConfigured: ReturnType<typeof vi.fn>;
    checkConnection?: ReturnType<typeof vi.fn>;
    getConnectUrl: () => null;
    exchangeRequestToken: ReturnType<typeof vi.fn>;
    fetchInstruments: ReturnType<typeof vi.fn>;
    fetchDailyCandles: ReturnType<typeof vi.fn>;
  };

  const makeAdapter = (
    providerKey: string,
    requiresConnection: boolean,
    hasCheckConnection: boolean
  ): FakeAdapter => ({
    providerKey,
    requiresConnection,
    isConfigured: vi.fn(() => true),
    ...(hasCheckConnection ? { checkConnection: vi.fn() } : {}),
    getConnectUrl: () => null,
    exchangeRequestToken: vi.fn(),
    fetchInstruments: vi.fn(),
    fetchDailyCandles: vi.fn(),
  });

  return {
    zerodha: makeAdapter("zerodha", true, false),
    globalDatafeeds: makeAdapter("global-datafeeds", false, true),
    eodhd: makeAdapter("eodhd", false, true),
    selectMock: vi.fn(),
    updateMock: vi.fn(),
  };
});

const adaptersByKey: Record<string, unknown> = {
  zerodha: h.zerodha,
  "global-datafeeds": h.globalDatafeeds,
  eodhd: h.eodhd,
};

vi.mock("../../db/client", () => ({
  db: { select: h.selectMock, update: h.updateMock },
}));

vi.mock("./data-provider.registry", () => ({
  getDataProviderAdapterByProvider: vi.fn((key: string) => adaptersByKey[key] ?? null),
  listDataProviderAdapters: vi.fn(() => [h.zerodha, h.globalDatafeeds, h.eodhd]),
  adapterSupportsCapability: vi.fn(),
  getCandidateProviderKeysForExchange: vi.fn(() => []),
  getConnectableDataProviderAdapter: vi.fn(() => h.zerodha),
  getDataProviderAdapterForExchange: vi.fn(() => h.zerodha),
  getEodhdDataProviderAdapter: vi.fn(() => h.eodhd),
}));

vi.mock("./data-provider-settings.service", () => ({
  getProviderPriority: vi.fn(async () => 1),
  isProviderEnabled: vi.fn(async () => true),
  recordProviderFailure: vi.fn(),
  recordProviderSuccess: vi.fn(),
}));

import * as settingsService from "./data-provider-settings.service";
import {
  getAllProviderLocalStatuses,
  getProviderHealth,
  getProviderStatus,
  PROVIDER_HEALTH_CHECK_TIMEOUT_MS,
} from "./data-provider.service";

const recordProviderSuccess = vi.mocked(settingsService.recordProviderSuccess);
const recordProviderFailure = vi.mocked(settingsService.recordProviderFailure);

// db.select().from().where().orderBy().limit() chain that resolves to `rows`.
function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.from = self;
  c.where = self;
  c.orderBy = self;
  c.limit = self;
  c.then = (resolve: (v: unknown[]) => unknown, reject: (e?: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

// db.update().set().where() chain that resolves to undefined.
function updateChain() {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.set = self;
  c.where = self;
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return c;
}

const HEALTHY = { connected: true, status: "connected", errorMessage: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.zerodha.isConfigured.mockReturnValue(true);
  h.globalDatafeeds.isConfigured.mockReturnValue(true);
  h.eodhd.isConfigured.mockReturnValue(true);
  h.globalDatafeeds.checkConnection?.mockResolvedValue(HEALTHY);
  h.eodhd.checkConnection?.mockResolvedValue(HEALTHY);
  h.selectMock.mockReturnValue(selectChain([]));
  h.updateMock.mockReturnValue(updateChain());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getProviderStatus - local/DB only", () => {
  it("never calls adapter.checkConnection() for a non-OAuth provider", async () => {
    const result = await getProviderStatus("global-datafeeds");

    expect(h.globalDatafeeds.checkConnection).not.toHaveBeenCalled();
    expect(result.providerConfigured).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.status).toBe("connected");
  });

  it("returns 'missing' immediately (no external call) when isConfigured() is false", async () => {
    h.globalDatafeeds.isConfigured.mockReturnValue(false);

    const result = await getProviderStatus("global-datafeeds");

    expect(h.globalDatafeeds.checkConnection).not.toHaveBeenCalled();
    expect(result.providerConfigured).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.status).toBe("disconnected");
  });

  it("does not record a health observation for a non-OAuth provider (no health was checked)", async () => {
    await getProviderStatus("eodhd");

    expect(recordProviderSuccess).not.toHaveBeenCalled();
    expect(recordProviderFailure).not.toHaveBeenCalled();
  });

  it("preserves Zerodha's DB-derived connected state", async () => {
    h.selectMock.mockReturnValue(
      selectChain([
        {
          id: "conn-1",
          status: "connected",
          expiresAt: new Date(Date.now() + 3_600_000),
          lastSyncedAt: new Date("2026-01-02T00:00:00Z"),
          errorMessage: null,
        },
      ])
    );

    const result = await getProviderStatus("zerodha");

    expect(result.connected).toBe(true);
    expect(result.status).toBe("connected");
    expect(result.lastSyncedAt).toBe(new Date("2026-01-02T00:00:00Z").toISOString());
    expect(h.zerodha.checkConnection).toBeUndefined();
  });

  it("preserves Zerodha's expired-token semantics (DB read + write-back, still no external call)", async () => {
    h.selectMock.mockReturnValue(
      selectChain([
        {
          id: "conn-1",
          status: "connected",
          expiresAt: new Date(Date.now() - 1_000),
          lastSyncedAt: null,
          errorMessage: null,
        },
      ])
    );

    const result = await getProviderStatus("zerodha");

    expect(result.status).toBe("expired");
    expect(result.connected).toBe(false);
    expect(h.updateMock).toHaveBeenCalledTimes(1);
  });
});

describe("getAllProviderLocalStatuses - local/DB only", () => {
  it("returns every provider with no checkConnection call, even if a check would reject", async () => {
    h.globalDatafeeds.checkConnection?.mockRejectedValue(new Error("WS dead"));
    h.eodhd.checkConnection?.mockRejectedValue(new Error("HTTP dead"));

    const { providers } = await getAllProviderLocalStatuses();

    expect(providers.map((p) => p.provider).sort()).toEqual([
      "eodhd",
      "global-datafeeds",
      "zerodha",
    ]);
    expect(h.globalDatafeeds.checkConnection).not.toHaveBeenCalled();
    expect(h.eodhd.checkConnection).not.toHaveBeenCalled();
  });

  it("includes local metadata fields (enabled, priority, requiresConnection)", async () => {
    vi.mocked(settingsService.isProviderEnabled).mockImplementation(
      async (key: string) => key !== "eodhd"
    );
    vi.mocked(settingsService.getProviderPriority).mockResolvedValue(7);

    const { providers } = await getAllProviderLocalStatuses();
    const byKey = new Map(providers.map((p) => [p.provider, p]));

    expect(byKey.get("global-datafeeds")).toMatchObject({
      enabled: true,
      priority: 7,
      requiresConnection: false,
    });
    expect(byKey.get("eodhd")?.enabled).toBe(false);
    expect(byKey.get("zerodha")?.requiresConnection).toBe(true);
  });
});

describe("getProviderHealth - bounded external check", () => {
  it("runs the adapter check and returns its result tagged with the provider", async () => {
    h.globalDatafeeds.checkConnection?.mockResolvedValue(HEALTHY);

    const result = await getProviderHealth("global-datafeeds");

    expect(h.globalDatafeeds.checkConnection).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      provider: "global-datafeeds",
      connected: true,
      status: "connected",
      errorMessage: null,
    });
  });

  it("returns a deterministic timed-out error when the adapter check hangs", async () => {
    vi.useFakeTimers();
    h.globalDatafeeds.checkConnection?.mockReturnValue(new Promise(() => {}));

    const pending = getProviderHealth("global-datafeeds");
    await vi.advanceTimersByTimeAsync(PROVIDER_HEALTH_CHECK_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({
      provider: "global-datafeeds",
      connected: false,
      status: "error",
      errorMessage: "Health check timed out",
    });
  });

  it("isolates one provider's failure from another's health call", async () => {
    h.globalDatafeeds.checkConnection?.mockRejectedValue(new Error("WS dead"));
    h.eodhd.checkConnection?.mockResolvedValue(HEALTHY);

    const gdf = await getProviderHealth("global-datafeeds");
    const eodhd = await getProviderHealth("eodhd");

    expect(gdf.status).toBe("error");
    expect(gdf.errorMessage).toBe("WS dead");
    expect(eodhd.connected).toBe(true);
  });

  it("records the health observation into the throttled tracker", async () => {
    h.eodhd.checkConnection?.mockResolvedValue(HEALTHY);
    await getProviderHealth("eodhd");
    expect(recordProviderSuccess).toHaveBeenCalledWith("eodhd");

    h.globalDatafeeds.checkConnection?.mockResolvedValue({
      connected: false,
      status: "error",
      errorMessage: "boom",
    });
    await getProviderHealth("global-datafeeds");
    expect(recordProviderFailure).toHaveBeenCalledWith("global-datafeeds", "boom");
  });
});
