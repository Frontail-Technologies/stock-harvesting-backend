import { describe, expect, it } from "vitest";

import {
  assertWatchlistOwnership,
  findDuplicateWatchlistItem,
  groupSymbolsByExchange,
} from "./watchlists.service";

// These two functions are the only DB-independent decision points in the
// watchlists service - the rest is plain Drizzle CRUD wired to them (same
// division as price-alerts.service.ts). No Postgres is reachable in this
// environment (see market-data.backfill-atomicity.test.ts), so, matching
// that existing precedent, the ownership/duplicate *logic* is what's unit
// tested here rather than the DB plumbing around it.
describe("assertWatchlistOwnership", () => {
  it("does not throw when the watchlist belongs to the requesting user", () => {
    expect(() =>
      assertWatchlistOwnership({ userId: "user-1" }, "user-1")
    ).not.toThrow();
  });

  it("throws not-found when the watchlist does not exist", () => {
    expect(() => assertWatchlistOwnership(null, "user-1")).toThrow("Watchlist not found");
    expect(() => assertWatchlistOwnership(undefined, "user-1")).toThrow("Watchlist not found");
  });

  it("throws forbidden when the watchlist belongs to another user", () => {
    expect(() => assertWatchlistOwnership({ userId: "user-2" }, "user-1")).toThrow(
      "Watchlist belongs to another user"
    );
  });
});

describe("findDuplicateWatchlistItem", () => {
  const items = [
    { exchange: "NSE", symbol: "RELIANCE" },
    { exchange: "BSE", symbol: "TCS" },
  ];

  it("finds an existing item with the same exchange and symbol", () => {
    expect(findDuplicateWatchlistItem(items, "NSE", "RELIANCE")).toEqual({
      exchange: "NSE",
      symbol: "RELIANCE",
    });
  });

  it("normalizes the candidate symbol before comparing", () => {
    expect(findDuplicateWatchlistItem(items, "NSE", "reliance")).toEqual({
      exchange: "NSE",
      symbol: "RELIANCE",
    });
  });

  it("treats the same symbol on a different exchange as distinct", () => {
    expect(findDuplicateWatchlistItem(items, "BSE", "RELIANCE")).toBeNull();
  });

  it("returns null when no item matches", () => {
    expect(findDuplicateWatchlistItem(items, "NSE", "INFY")).toBeNull();
  });
});

// Feeds getWatchlistRelativeStrength (a Watchlist's stocks ranked through
// the same relative-strength evaluator Dashboard's Stock Harvest widget
// uses) - the evaluator itself computes per single exchange, so a mixed-
// exchange Watchlist has to be bucketed first. Pure/DB-independent, tested
// directly for the same reason as the two describe blocks above.
describe("groupSymbolsByExchange", () => {
  it("groups symbols under their exchange", () => {
    const grouped = groupSymbolsByExchange([
      { exchange: "NSE", symbol: "RELIANCE" },
      { exchange: "BSE", symbol: "TCS" },
      { exchange: "NSE", symbol: "INFY" },
    ]);

    expect(grouped.get("NSE")).toEqual(["RELIANCE", "INFY"]);
    expect(grouped.get("BSE")).toEqual(["TCS"]);
    expect(grouped.size).toBe(2);
  });

  it("preserves per-exchange symbol order", () => {
    const grouped = groupSymbolsByExchange([
      { exchange: "BSE", symbol: "WIPRO" },
      { exchange: "BSE", symbol: "TCS" },
      { exchange: "BSE", symbol: "GROWW" },
    ]);

    expect(grouped.get("BSE")).toEqual(["WIPRO", "TCS", "GROWW"]);
  });

  it("returns an empty map for an empty watchlist", () => {
    expect(groupSymbolsByExchange([]).size).toBe(0);
  });

  it("keeps a single-exchange watchlist to one bucket", () => {
    const grouped = groupSymbolsByExchange([
      { exchange: "NSE", symbol: "A" },
      { exchange: "NSE", symbol: "B" },
    ]);

    expect(grouped.size).toBe(1);
    expect(grouped.get("NSE")).toEqual(["A", "B"]);
  });
});
