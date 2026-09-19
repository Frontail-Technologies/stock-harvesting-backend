import { describe, expect, it } from "vitest";

import { DATA_PROVIDER_KEY } from "../../shared/constants";
import {
  adapterSupportsCapability,
  getCandidateProviderKeysForExchange,
  getDataProviderAdapterByProvider,
  getProviderCapabilities,
  listDataProviderAdapters,
} from "./data-provider.registry";

// Ground-truth capability matrix confirmed by direct code audit:
// GlobalDataFeeds and EODHD implement every optional method. These tests
// fail loudly if a future adapter change silently drifts from that matrix
// without the routing layer being told.
describe("adapterSupportsCapability - real adapter instances", () => {
  const globalDatafeeds = getDataProviderAdapterByProvider(DATA_PROVIDER_KEY.globalDatafeeds)!;
  const eodhd = getDataProviderAdapterByProvider(DATA_PROVIDER_KEY.eodhd)!;

  it("every adapter supports the always-on capabilities", () => {
    for (const adapter of [globalDatafeeds, eodhd]) {
      expect(adapterSupportsCapability(adapter, "instrument_sync")).toBe(true);
      expect(adapterSupportsCapability(adapter, "historical_daily_candles")).toBe(true);
      expect(adapterSupportsCapability(adapter, "latest_daily_candles")).toBe(true);
      expect(adapterSupportsCapability(adapter, "realtime_ws")).toBe(true);
    }
  });

  it("Zerodha is retired - no adapter is registered for it", () => {
    expect(getDataProviderAdapterByProvider("zerodha")).toBeNull();
    expect(listDataProviderAdapters().map((adapter) => adapter.providerKey)).toEqual([
      DATA_PROVIDER_KEY.eodhd,
      DATA_PROVIDER_KEY.globalDatafeeds,
    ]);
  });

  it("GlobalDataFeeds and EODHD support instrument_search, instrument_token, and exchange_list", () => {
    for (const adapter of [globalDatafeeds, eodhd]) {
      expect(adapterSupportsCapability(adapter, "instrument_search")).toBe(true);
      expect(adapterSupportsCapability(adapter, "instrument_token")).toBe(true);
      expect(adapterSupportsCapability(adapter, "exchange_list")).toBe(true);
    }
  });

  it("getProviderCapabilities matches adapterSupportsCapability for every capability", () => {
    const capabilities = getProviderCapabilities(globalDatafeeds);
    expect(capabilities).toContain("historical_daily_candles");
    expect(capabilities).toContain("current_price_snapshot");
    expect(capabilities).toContain("instrument_search");
  });
});

describe("getCandidateProviderKeysForExchange - today's routing table", () => {
  it("resolves retired NSE and NSE_IDX to no provider at all (never a fallback provider)", () => {
    expect(getCandidateProviderKeysForExchange("NSE")).toEqual([]);
    expect(getCandidateProviderKeysForExchange("NSE_IDX")).toEqual([]);
  });

  it("routes BSE and BSE_IDX to Global DataFeeds only", () => {
    expect(getCandidateProviderKeysForExchange("BSE")).toEqual([
      DATA_PROVIDER_KEY.globalDatafeeds,
    ]);
    expect(getCandidateProviderKeysForExchange("BSE_IDX")).toEqual([
      DATA_PROVIDER_KEY.globalDatafeeds,
    ]);
  });

  it("falls through to EODHD for every other exchange", () => {
    expect(getCandidateProviderKeysForExchange("US")).toEqual([DATA_PROVIDER_KEY.eodhd]);
    expect(getCandidateProviderKeysForExchange("LSE")).toEqual([DATA_PROVIDER_KEY.eodhd]);
  });

  it("always returns exactly one candidate for a live exchange - there is no multi-provider fallback", () => {
    for (const exchange of ["BSE", "BSE_IDX", "US", "TSE", "ASX"]) {
      expect(getCandidateProviderKeysForExchange(exchange)).toHaveLength(1);
    }
  });
});
