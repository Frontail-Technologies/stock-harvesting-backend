import { describe, expect, it } from "vitest";

import { canSubscribeToAdminMarketData, normalizeStreamSymbol, streamSymbolKey } from "./market-stream.utils";
import type { MarketStreamUser } from "./market-stream.types";

function user(overrides: Partial<MarketStreamUser> = {}): MarketStreamUser {
  return { id: "u1", email: "a@b.com", role: "user", plan: "free", portal: "user", ...overrides };
}

describe("canSubscribeToAdminMarketData", () => {
  it("allows an admin-portal token belonging to an admin-role account", () => {
    expect(canSubscribeToAdminMarketData(user({ portal: "admin", role: "admin" }))).toBe(true);
  });

  it("rejects an admin-role account authenticated on the user portal", () => {
    expect(canSubscribeToAdminMarketData(user({ portal: "user", role: "admin" }))).toBe(false);
  });

  it("rejects a non-admin role even on the admin portal", () => {
    expect(canSubscribeToAdminMarketData(user({ portal: "admin", role: "user" }))).toBe(false);
  });

  it("rejects a plain user-portal user", () => {
    expect(canSubscribeToAdminMarketData(user())).toBe(false);
  });
});

describe("normalizeStreamSymbol / streamSymbolKey", () => {
  it("uppercases and trims exchange/symbol", () => {
    expect(normalizeStreamSymbol({ exchange: " bse ", symbol: " tcs " })).toEqual({
      exchange: "BSE",
      symbol: "TCS",
    });
  });

  it("builds a stable key", () => {
    expect(streamSymbolKey({ exchange: "BSE", symbol: "TCS" })).toBe("BSE:TCS");
  });
});
