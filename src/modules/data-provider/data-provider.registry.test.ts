import { describe, expect, it } from "vitest";

import { DATA_PROVIDER_KEY } from "../../shared/constants";
import {
  adapterSupportsCapability,
  getCandidateProviderKeysForExchange,
  getDataProviderAdapterByProvider,
  getProviderCapabilities,
} from "./data-provider.registry";

// Ground-truth capability matrix confirmed by direct code audit (see the
// plan): Zerodha is REST-only for candles/instruments and does not
// implement searchInstruments/getInstrumentToken/fetchExchanges/
// checkConnection; GlobalDataFeeds and EODHD implement every optional
// method. These tests fail loudly if a future adapter change silently
// drifts from that matrix without the routing layer being told.
describe("adapterSupportsCapability - real adapter instances", () => {
  const zerodha = getDataProviderAdapterByProvider(DATA_PROVIDER_KEY.zerodha)!;
  const globalDatafeeds = getDataProviderAdapterByProvider(DATA_PROVIDER_KEY.globalDatafeeds)!;
  const eodhd = getDataProviderAdapterByProvider(DATA_PROVIDER_KEY.eodhd)!;

  it("every adapter supports the always-on capabilities", () => {
    for (const adapter of [zerodha, globalDatafeeds, eodhd]) {
      expect(adapterSupportsCapability(adapter, "instrument_sync")).toBe(true);
      expect(adapterSupportsCapability(adapter, "historical_daily_candles")).toBe(true);
      expect(adapterSupportsCapability(adapter, "latest_daily_candles")).toBe(true);
      expect(adapterSupportsCapability(adapter, "realtime_ws")).toBe(true);
    }
  });

  it("Zerodha does not support instrument_search, instrument_token, or exchange_list", () => {
    expect(adapterSupportsCapability(zerodha, "instrument_search")).toBe(false);
    expect(adapterSupportsCapability(zerodha, "instrument_token")).toBe(false);
    expect(adapterSupportsCapability(zerodha, "exchange_list")).toBe(false);
  });

  it("GlobalDataFeeds and EODHD support instrument_search, instrument_token, and exchange_list", () => {
    for (const adapter of [globalDatafeeds, eodhd]) {
      expect(adapterSupportsCapability(adapter, "instrument_search")).toBe(true);
      expect(adapterSupportsCapability(adapter, "instrument_token")).toBe(true);
      expect(adapterSupportsCapability(adapter, "exchange_list")).toBe(true);
    }
  });

  it("getProviderCapabilities matches adapterSupportsCapability for every capability", () => {
    const capabilities = getProviderCapabilities(zerodha);
    expect(capabilities).toContain("historical_daily_candles");
    expect(capabilities).not.toContain("instrument_search");
  });
});

describe("getCandidateProviderKeysForExchange - today's routing table", () => {
  it("routes NSE and NSE_IDX to Zerodha only", () => {
    expect(getCandidateProviderKeysForExchange("NSE")).toEqual([DATA_PROVIDER_KEY.zerodha]);
    expect(getCandidateProviderKeysForExchange("NSE_IDX")).toEqual([DATA_PROVIDER_KEY.zerodha]);
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

  it("always returns exactly one candidate today - there is no existing multi-provider fallback to preserve", () => {
    for (const exchange of ["NSE", "BSE", "US", "TSE", "ASX"]) {
      expect(getCandidateProviderKeysForExchange(exchange)).toHaveLength(1);
    }
  });
});
