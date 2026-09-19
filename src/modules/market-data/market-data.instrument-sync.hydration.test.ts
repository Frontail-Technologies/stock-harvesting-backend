import { beforeEach, describe, expect, it, vi } from "vitest";

const getEligibleProviderAdapter = vi.hoisted(() => vi.fn());
const createFallbackInstrument = vi.hoisted(() => vi.fn());
const upsertInstruments = vi.hoisted(() => vi.fn());
const fetchInstruments = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../data-provider/data-provider.service", () => ({
  getActiveProviderAccessToken: vi.fn().mockResolvedValue(undefined),
  getEligibleProviderAdapter,
}));
vi.mock("../data-provider/data-provider-settings.service", () => ({
  recordProviderFailure: vi.fn(),
  recordProviderSuccess: vi.fn(),
}));
vi.mock("../jobs/queues", () => ({ enqueueCandleBootstrapJobs: vi.fn().mockResolvedValue({ queued: 0 }) }));
vi.mock("./market-data.instruments", () => ({
  createFallbackInstrument,
  getInstrumentsBySymbol: vi.fn().mockResolvedValue(new Map()),
  upsertInstruments,
}));

import { hydrateMarketInstruments } from "./market-data.instrument-sync";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hydrateMarketInstruments - provider is the only source of the universe", () => {
  it("persists exactly what the provider returned", async () => {
    fetchInstruments.mockResolvedValue([{ symbol: "AAA", name: "A", exchange: "BSE", instrumentToken: "1" }]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchInstruments });

    const result = await hydrateMarketInstruments("BSE");

    expect(result.count).toBe(1);
    expect(upsertInstruments).toHaveBeenCalledWith(
      [{ symbol: "AAA", name: "A", exchange: "BSE", instrumentToken: "1" }],
      "global-datafeeds"
    );
  });

  it("creates no instruments from any static symbol list when the provider returns nothing", async () => {
    fetchInstruments.mockResolvedValue([]);
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchInstruments });

    const result = await hydrateMarketInstruments("BSE");

    expect(result.count).toBe(0);
    expect(createFallbackInstrument).not.toHaveBeenCalled();
  });

  it("creates no instruments from any static symbol list when the provider sync fails", async () => {
    fetchInstruments.mockRejectedValue(new Error("provider down"));
    getEligibleProviderAdapter.mockResolvedValue({ providerKey: "global-datafeeds", fetchInstruments });

    const result = await hydrateMarketInstruments("US");

    expect(result.count).toBe(0);
    expect(createFallbackInstrument).not.toHaveBeenCalled();
  });

  it("does nothing for an exchange with no eligible provider (e.g. retired NSE)", async () => {
    getEligibleProviderAdapter.mockResolvedValue(null);

    const result = await hydrateMarketInstruments("NSE");

    expect(result.count).toBe(0);
    expect(fetchInstruments).not.toHaveBeenCalled();
    expect(createFallbackInstrument).not.toHaveBeenCalled();
  });
});
