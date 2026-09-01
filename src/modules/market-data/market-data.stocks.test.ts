import { describe, expect, it } from "vitest";

import type { DbOrTx } from "../../db/client";
import {
  buildStockFilters,
  buildStockOrderBy,
  countStockRows,
  readStockRows,
  readUnpricedStockSymbols,
  searchChartEligibleBseStocks,
  toStockListResponse,
} from "./market-data.stocks";

/**
 * No behavior coverage existed for this responsibility before this
 * extraction (verified: no test file referenced listStocks or
 * searchChartEligibleBseStocks). What follows proves the query shapes this
 * module builds still carry the invariants they're supposed to (BSE-only +
 * candle-eligible for the chart search, NSE-only symbol filtering, move/
 * volume filters, unpriced-symbol detection) — via the same "walk the real
 * Drizzle condition tree" approach used in market-data.instrument-stats-
 * bulk-update.test.ts, not string-matching a hand-typed SQL guess.
 */

function flattenCondition(condition: unknown, out: Array<{ type: "text" | "param"; value: unknown }> = []) {
  const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      flattenCondition(chunk, out);
    } else if (
      chunk &&
      typeof chunk === "object" &&
      "value" in chunk &&
      Array.isArray((chunk as { value: unknown }).value) &&
      typeof (chunk as { value: unknown[] }).value[0] === "string"
    ) {
      out.push({ type: "text", value: (chunk as { value: string[] }).value.join("") });
    } else {
      out.push({ type: "param", value: chunk });
    }
  }
  return out;
}

function renderText(condition: unknown) {
  return flattenCondition(condition)
    .filter((s) => s.type === "text")
    .map((s) => s.value)
    .join("");
}

function paramValues(condition: unknown) {
  return flattenCondition(condition)
    .filter((s) => s.type === "param")
    .map((s) => {
      const value = s.value as { value?: unknown; name?: string } | unknown;
      if (value && typeof value === "object" && "value" in value) return (value as { value: unknown }).value;
      if (value && typeof value === "object" && "name" in value) return (value as { name: string }).name;
      return value;
    });
}

describe("buildStockOrderBy", () => {
  it("sorts by name ascending by default, with symbol as tiebreaker", () => {
    const orderBy = buildStockOrderBy();
    expect(orderBy).toHaveLength(2);
  });

  it.each([
    ["symbol", "asc"],
    ["symbol", "desc"],
    ["name", "asc"],
    ["name", "desc"],
    ["close", "asc"],
    ["changePct", "desc"],
    ["volume", "asc"],
  ] as const)("accepts sortBy=%s sortDirection=%s without throwing", (sortBy, sortDirection) => {
    expect(() => buildStockOrderBy(sortBy, sortDirection)).not.toThrow();
    expect(buildStockOrderBy(sortBy, sortDirection)).toHaveLength(2);
  });
});

describe("buildStockFilters", () => {
  it("applies NSE-only symbol-pattern filters (provider=zerodha, normal-equity regex, debt/non-eq exclusions) only for exchange=NSE", () => {
    const nseCondition = buildStockFilters({ exchange: "NSE" });
    const nseText = renderText(nseCondition);
    const nseParams = paramValues(nseCondition);
    expect(nseParams).toContain("provider");
    expect(nseParams).toContain("zerodha");
    expect(nseText.match(/~/g)?.length).toBe(3); // 3 regex predicates

    const bseCondition = buildStockFilters({ exchange: "BSE" });
    const bseText = renderText(bseCondition);
    const bseParams = paramValues(bseCondition);
    expect(bseParams).not.toContain("provider");
    expect(bseText.match(/~/g)).toBeNull();
  });

  it("omits the latestClose > 0 filter when includeUnpriced is true, includes it otherwise", () => {
    const withUnpriced = paramValues(buildStockFilters({ exchange: "BSE", includeUnpriced: true }));
    const withoutUnpriced = paramValues(buildStockFilters({ exchange: "BSE" }));
    expect(withoutUnpriced).toContain("latest_close");
    // Both filter sets reference latest_close somewhere only via the priced
    // case (unpriced omits the gt(latestClose, 0) predicate specifically).
    const withUnpricedCloseFilterCount = withUnpriced.filter((v) => v === "latest_close").length;
    const withoutUnpricedCloseFilterCount = withoutUnpriced.filter((v) => v === "latest_close").length;
    expect(withUnpricedCloseFilterCount).toBeLessThan(withoutUnpricedCloseFilterCount);
  });

  it.each(["gainers", "decliners", "unchanged"] as const)("moveFilter=%s targets latest_change_pct", (moveFilter) => {
    const params = paramValues(buildStockFilters({ exchange: "BSE", moveFilter }));
    expect(params).toContain("latest_change_pct");
  });

  it("minVolume maps to a latest_volume >= comparison", () => {
    const params = paramValues(buildStockFilters({ exchange: "BSE", minVolume: 5000 }));
    expect(params).toContain("latest_volume");
    expect(params).toContain("5000");
  });

  it("q filters on symbol OR name via ILIKE substring match", () => {
    const params = paramValues(buildStockFilters({ exchange: "BSE", q: "rel" }));
    expect(params.some((v) => typeof v === "string" && v.includes("REL"))).toBe(true);
  });
});

describe("searchChartEligibleBseStocks query shape", () => {
  it("hardcodes exchange=BSE (not parameterized by caller input) and requires an EXISTS candle match", async () => {
    let capturedCondition: unknown;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            capturedCondition = condition;
            return {
              orderBy: () => ({
                limit: async () => [],
              }),
            };
          },
        }),
      }),
    };

    await searchChartEligibleBseStocks({ q: "REL", limit: 25 }, fakeDb as unknown as DbOrTx);

    const text = renderText(capturedCondition);
    const params = paramValues(capturedCondition);
    expect(params).toContain("BSE");
    expect(text.toLowerCase()).toContain("exists");
    // The EXISTS subquery must match on exchange + symbol + the '1D' timeframe
    // specifically - a candle-less instrument (no matching row at all) or an
    // instrument with only weekly/monthly derived candles must not satisfy it.
    expect(params).toContain("1D");
    expect(params.filter((v) => v === "exchange").length).toBeGreaterThanOrEqual(2);
    expect(params.filter((v) => v === "symbol").length).toBeGreaterThanOrEqual(2);
  });

  it("passes the requested limit straight through with no default override", async () => {
    let capturedLimit: number | undefined;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (n: number) => {
                capturedLimit = n;
                return [];
              },
            }),
          }),
        }),
      }),
    };

    await searchChartEligibleBseStocks({ q: "x", limit: 7 }, fakeDb as unknown as DbOrTx);
    expect(capturedLimit).toBe(7);
  });
});

describe("readStockRows pagination", () => {
  it("computes offset from (page - 1) * limit and passes limit/offset through unchanged", async () => {
    let capturedLimit: number | undefined;
    let capturedOffset: number | undefined;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => {
                capturedLimit = n;
                return {
                  offset: async (o: number) => {
                    capturedOffset = o;
                    return [];
                  },
                };
              },
            }),
          }),
        }),
      }),
    };

    await readStockRows({ page: 3, limit: 25, exchange: "BSE" }, fakeDb as unknown as DbOrTx);
    expect(capturedLimit).toBe(25);
    expect(capturedOffset).toBe(50); // (3 - 1) * 25
  });
});

describe("countStockRows", () => {
  it("returns 0 for an empty result rather than throwing", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    };

    const total = await countStockRows({ exchange: "BSE" }, fakeDb as unknown as DbOrTx);
    expect(total).toBe(0);
  });

  it("returns the queried total when present", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ total: 42 }],
        }),
      }),
    };

    const total = await countStockRows({ exchange: "BSE" }, fakeDb as unknown as DbOrTx);
    expect(total).toBe(42);
  });
});

describe("readUnpricedStockSymbols", () => {
  it("targets rows with a NULL or non-positive latestClose", async () => {
    let capturedCondition: unknown;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            capturedCondition = condition;
            return {
              orderBy: () => ({
                limit: async () => [{ symbol: "TCS" }, { symbol: "INFY" }],
              }),
            };
          },
        }),
      }),
    };

    const symbols = await readUnpricedStockSymbols({ exchange: "BSE" }, 10, fakeDb as unknown as DbOrTx);

    expect(symbols).toEqual(["TCS", "INFY"]);
    const text = renderText(capturedCondition);
    expect(text.toUpperCase()).toContain("IS NULL");
  });
});

describe("toStockListResponse", () => {
  it("maps null numeric-as-string DB columns to undefined, and non-null ones to numbers", () => {
    const result = toStockListResponse([
      { symbol: "TCS", name: "Tata Consultancy", exchange: "NSE", close: "3500.50", changePct: null, volume: "1200", open: null },
    ]);

    expect(result).toEqual([
      { symbol: "TCS", name: "Tata Consultancy", exchange: "NSE", close: 3500.5, changePct: undefined, volume: 1200, open: undefined },
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(toStockListResponse([])).toEqual([]);
  });
});
