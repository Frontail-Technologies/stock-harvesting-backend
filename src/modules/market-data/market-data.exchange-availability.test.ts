import { beforeEach, describe, expect, it, vi } from "vitest";

// listSupportedExchanges must genuinely reflect usable availability (enabled
// AND, for BSE, has active GlobalDataFeeds instruments) rather than just
// "not explicitly disabled" - see market-data.service.ts's own comment.
// NSE was Zerodha-only and is retired: it must never be advertised, even if
// EODHD's own exchange list happens to include it.
// getOrSetCache is bypassed so each test observes a fresh computation
// instead of a cached one from a prior test.

vi.mock("../../shared/cache", () => ({
  getOrSetCache: (_key: string, _ttlMs: number, compute: () => unknown) => compute(),
}));
vi.mock("../data-provider/data-provider-settings.service", () => ({
  isProviderEnabled: vi.fn(),
  recordProviderFailure: vi.fn(),
  recordProviderSuccess: vi.fn(),
}));

const eodhdFetchExchanges = vi.hoisted(() => vi.fn());
vi.mock("../data-provider/data-provider.service", () => ({
  getActiveProviderAccessToken: vi.fn(),
  getEligibleProviderAdapter: vi.fn(),
  getEodhdDataProviderAdapter: vi.fn(() => ({
    providerKey: "eodhd",
    fetchExchanges: eodhdFetchExchanges,
  })),
}));
vi.mock("./market-data.instruments", () => ({
  applyLatestInstrumentStats: vi.fn(),
  dedupeInstrumentUpsertInputs: vi.fn(),
  hasActiveInstruments: vi.fn(),
}));

import * as providerSettingsModule from "../data-provider/data-provider-settings.service";
import * as instrumentsModule from "./market-data.instruments";
import { listSupportedExchanges } from "./market-data.service";

const isProviderEnabled = vi.mocked(providerSettingsModule.isProviderEnabled);
const hasActiveInstruments = vi.mocked(instrumentsModule.hasActiveInstruments);

function exchangeCodes(exchanges: Array<{ code: string }>) {
  return exchanges.map((exchange) => exchange.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  eodhdFetchExchanges.mockResolvedValue([]);
});

describe("listSupportedExchanges - exchange availability", () => {
  it("BSE with active GlobalDataFeeds instruments => BSE shown", async () => {
    isProviderEnabled.mockResolvedValue(true);
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).toContain("BSE");
    expect(hasActiveInstruments).toHaveBeenCalledWith("BSE", "global-datafeeds");
  });

  it("BSE with zero active GlobalDataFeeds instruments => BSE hidden", async () => {
    isProviderEnabled.mockResolvedValue(true);
    hasActiveInstruments.mockResolvedValue(false);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("BSE");
  });

  it("GlobalDataFeeds disabled => BSE and BSE_IDX are hidden even with active instruments", async () => {
    isProviderEnabled.mockImplementation(async (key: string) => key !== "global-datafeeds");
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("BSE");
    expect(exchangeCodes(exchanges)).not.toContain("BSE_IDX");
  });

  it("NSE is retired - never advertised and never probed, even with active NSE instruments", async () => {
    isProviderEnabled.mockResolvedValue(true);
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    expect(hasActiveInstruments).not.toHaveBeenCalledWith("NSE", expect.anything());
  });

  it("NSE stays hidden even when EODHD's own exchange list includes it", async () => {
    isProviderEnabled.mockResolvedValue(true);
    hasActiveInstruments.mockResolvedValue(true);
    eodhdFetchExchanges.mockResolvedValue([
      { code: "NSE", name: "India (NSE)", currency: "INR", country: "India" },
      { code: "NSE_IDX", name: "India (NSE Indices)", currency: "INR", country: "India" },
      { code: "US", name: "United States", currency: "USD", country: "USA" },
    ]);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    expect(exchangeCodes(exchanges)).not.toContain("NSE_IDX");
    expect(exchangeCodes(exchanges)).toContain("US");
  });

  it("no supported exchange is falsely advertised when nothing is actually usable", async () => {
    isProviderEnabled.mockResolvedValue(true);
    hasActiveInstruments.mockResolvedValue(false);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    expect(exchangeCodes(exchanges)).not.toContain("BSE");
  });
});
