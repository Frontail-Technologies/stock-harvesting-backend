import { describe, expect, it } from "vitest";

import { getEffectiveScannerLookbackWeeks, SCANNER_LOOKBACK_WEEKS } from "./scanner.constants";

describe("SCANNER_LOOKBACK_WEEKS", () => {
  it("maps 1x to 50 weeks", () => {
    expect(SCANNER_LOOKBACK_WEEKS["1x"]).toBe(50);
  });

  it("maps 3x to 150 weeks", () => {
    expect(SCANNER_LOOKBACK_WEEKS["3x"]).toBe(150);
  });

  it("maps 5x to 250 weeks", () => {
    expect(SCANNER_LOOKBACK_WEEKS["5x"]).toBe(250);
  });
});

describe("getEffectiveScannerLookbackWeeks", () => {
  it("returns the requested tier when enough weekly history exists", () => {
    expect(getEffectiveScannerLookbackWeeks(250, 250)).toBe(250);
  });

  it("falls back to the next-smaller tier when history is short", () => {
    expect(getEffectiveScannerLookbackWeeks(250, 200)).toBe(150);
  });

  it("falls back all the way to 50 when only the smallest tier is covered", () => {
    expect(getEffectiveScannerLookbackWeeks(250, 60)).toBe(50);
  });

  it("returns null when even the smallest tier isn't covered", () => {
    expect(getEffectiveScannerLookbackWeeks(250, 49)).toBeNull();
  });

  describe("strict mode (no smaller-tier fallback)", () => {
    it("still returns the requested tier when enough weekly history exists", () => {
      expect(getEffectiveScannerLookbackWeeks(250, 250, { strict: true })).toBe(250);
    });

    it("returns null instead of falling back when history is short of the requested tier", () => {
      expect(getEffectiveScannerLookbackWeeks(250, 200, { strict: true })).toBeNull();
      expect(getEffectiveScannerLookbackWeeks(250, 60, { strict: true })).toBeNull();
      expect(getEffectiveScannerLookbackWeeks(250, 49, { strict: true })).toBeNull();
    });
  });
});
