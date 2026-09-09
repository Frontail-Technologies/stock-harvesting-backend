import { beforeEach, describe, expect, it, vi } from "vitest";

// listSupportedExchanges must genuinely reflect usable availability (enabled
// AND, for NSE, connected AND has active instruments) rather than just
// "not explicitly disabled" - see market-data.service.ts's own comment.
// Mocks hasActiveInstruments directly at the module boundary (rather than
// mocking raw db and relying on call-order assumptions) - the NSE and BSE
// checks run in parallel inside listSupportedExchanges, so which one
// touches the DB first is not deterministic; asserting per-exchange
// behavior via the exchange argument is robust regardless of ordering.
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
vi.mock("../data-provider/data-provider.service", () => ({
  getActiveProviderAccessToken: vi.fn(),
  getEligibleProviderAdapter: vi.fn(),
  getEodhdDataProviderAdapter: vi.fn(() => ({
    providerKey: "eodhd",
    fetchExchanges: vi.fn().mockResolvedValue([]),
  })),
  getProviderStatus: vi.fn(),
}));
vi.mock("./market-data.instruments", () => ({
  applyLatestInstrumentStats: vi.fn(),
  dedupeInstrumentUpsertInputs: vi.fn(),
  hasActiveInstruments: vi.fn(),
}));

import * as providerSettingsModule from "../data-provider/data-provider-settings.service";
import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentsModule from "./market-data.instruments";
import { listSupportedExchanges } from "./market-data.service";

const isProviderEnabled = vi.mocked(providerSettingsModule.isProviderEnabled);
const getProviderStatus = vi.mocked(providerServiceModule.getProviderStatus);
const hasActiveInstruments = vi.mocked(instrumentsModule.hasActiveInstruments);

function exchangeCodes(exchanges: Array<{ code: string }>) {
  return exchanges.map((exchange) => exchange.code);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listSupportedExchanges - exchange availability", () => {
  it("Zerodha enabled but disconnected + zero NSE instruments => NSE hidden", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockResolvedValue({ connected: false } as never);
    hasActiveInstruments.mockImplementation(async (exchange) => exchange === "BSE");

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    expect(exchangeCodes(exchanges)).toContain("BSE");
  });

  it("Zerodha enabled and connected but zero NSE instruments => NSE hidden", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockResolvedValue({ connected: true } as never);
    hasActiveInstruments.mockImplementation(async (exchange) => exchange === "BSE");

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
  });

  it("Zerodha connected + active NSE instruments => NSE shown", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockResolvedValue({ connected: true } as never);
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).toContain("NSE");
    expect(hasActiveInstruments).toHaveBeenCalledWith("NSE", "zerodha");
  });

  it("BSE with active GlobalDataFeeds instruments => BSE shown", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockResolvedValue({ connected: true } as never);
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).toContain("BSE");
    expect(hasActiveInstruments).toHaveBeenCalledWith("BSE", "global-datafeeds");
  });

  it("BSE with zero active GlobalDataFeeds instruments => BSE hidden", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockResolvedValue({ connected: true } as never);
    hasActiveInstruments.mockImplementation(async (exchange) => exchange === "NSE");

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("BSE");
  });

  it("provider disabled => its exchange is hidden even with active instruments and a live connection", async () => {
    isProviderEnabled.mockImplementation(async (key: string) => key !== "zerodha");
    getProviderStatus.mockResolvedValue({ connected: true } as never);
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    expect(exchangeCodes(exchanges)).toContain("BSE");
  });

  it("no supported exchange is falsely advertised when nothing is actually usable", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockResolvedValue({ connected: false } as never);
    hasActiveInstruments.mockResolvedValue(false);

    const exchanges = await listSupportedExchanges();

    // Only the two exchanges this fix governs (NSE and BSE equities) are
    // asserted - BSE_IDX (index data) is a separate, unaudited case this
    // fix deliberately leaves untouched, matching the task's explicit
    // NSE/BSE-only requirements.
    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    expect(exchangeCodes(exchanges)).not.toContain("BSE");
  });

  it("an unavailable/errored Zerodha connection check fails closed - NSE stays hidden even if instruments exist", async () => {
    isProviderEnabled.mockResolvedValue(true);
    getProviderStatus.mockRejectedValue(new Error("connection status lookup failed"));
    hasActiveInstruments.mockResolvedValue(true);

    const exchanges = await listSupportedExchanges();

    expect(exchangeCodes(exchanges)).not.toContain("NSE");
    // BSE is unaffected by NSE's connection-check failure - still shown.
    expect(exchangeCodes(exchanges)).toContain("BSE");
  });
});
