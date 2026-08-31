import { describe, expect, it } from "vitest";

import { assertWatchlistOwnership, findDuplicateWatchlistItem } from "./watchlists.service";

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
