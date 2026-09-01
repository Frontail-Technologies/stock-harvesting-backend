import { describe, expect, it } from "vitest";

import { marketDataRouter } from "./market-data.routes";
import * as marketDataService from "./market-data.service";

/**
 * Regression coverage for Phase 10's removal of the manual
 * currency-conversion feature (product decision: currency is now
 * determined automatically by the selected market/exchange, not by a
 * user-facing conversion flow). Proves the removed surface is actually
 * gone from both the route table and the service's public exports -
 * introspecting router.stack rather than spinning up a full HTTP server,
 * since these are pure "does this path exist" checks, not behavior tests.
 */

function registeredPaths(router: typeof marketDataRouter): string[] {
  return router.stack
    .map((layer) => (layer as { route?: { path?: string } }).route?.path)
    .filter((path): path is string => typeof path === "string");
}

describe("market data routes: removed manual currency conversion", () => {
  it("no longer registers the /exchange-rates route", () => {
    expect(registeredPaths(marketDataRouter)).not.toContain("/exchange-rates");
  });

  it("still registers the unrelated exchange-listing route (/exchanges)", () => {
    expect(registeredPaths(marketDataRouter)).toContain("/exchanges");
  });

  it("still registers the core stock-list/search/chart routes untouched by the removal", () => {
    const paths = registeredPaths(marketDataRouter);
    expect(paths).toContain("/stocks");
    expect(paths).toContain("/stocks/search");
    expect(paths).toContain("/charts/:symbol/candles");
  });
});

describe("market-data.service.ts: removed manual currency conversion exports", () => {
  it("no longer exports convertAmount, getUsdRate, or listExchangeRates", () => {
    expect("convertAmount" in marketDataService).toBe(false);
    expect("getUsdRate" in marketDataService).toBe(false);
    expect("listExchangeRates" in marketDataService).toBe(false);
  });

  it("still exports listSupportedExchanges, the legitimate exchange/currency-metadata source", () => {
    expect(typeof marketDataService.listSupportedExchanges).toBe("function");
  });
});
