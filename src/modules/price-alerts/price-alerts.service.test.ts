import { describe, expect, it } from "vitest";

import {
  getInvalidPriceAlertTargetMessage,
  isPriceAlertTriggered,
} from "./price-alerts.service";

describe("price alert trigger logic", () => {
  it("triggers ABOVE exactly at and above the target", () => {
    const base = { status: "ACTIVE" as const, condition: "ABOVE" as const, targetPrice: 1500 };

    expect(isPriceAlertTriggered({ ...base, price: 1499 })).toBe(false);
    expect(isPriceAlertTriggered({ ...base, price: 1500 })).toBe(true);
    expect(isPriceAlertTriggered({ ...base, price: 1501 })).toBe(true);
  });

  it("triggers BELOW exactly at and below the target", () => {
    const base = { status: "ACTIVE" as const, condition: "BELOW" as const, targetPrice: 1450 };

    expect(isPriceAlertTriggered({ ...base, price: 1451 })).toBe(false);
    expect(isPriceAlertTriggered({ ...base, price: 1450 })).toBe(true);
    expect(isPriceAlertTriggered({ ...base, price: 1449 })).toBe(true);
  });

  it("does not trigger alerts that have already left ACTIVE status", () => {
    expect(
      isPriceAlertTriggered({
        status: "TRIGGERED",
        condition: "ABOVE",
        targetPrice: 1500,
        price: 1600,
      })
    ).toBe(false);

    expect(
      isPriceAlertTriggered({
        status: "DISABLED",
        condition: "BELOW",
        targetPrice: 1450,
        price: 1400,
      })
    ).toBe(false);
  });
});

describe("price alert target placement", () => {
  it("rejects ABOVE targets that are already satisfied", () => {
    expect(
      getInvalidPriceAlertTargetMessage({
        condition: "ABOVE",
        targetPrice: 1400,
        currentPrice: 1500,
      })
    ).toContain("greater than the current price");
  });

  it("rejects BELOW targets that are already satisfied", () => {
    expect(
      getInvalidPriceAlertTargetMessage({
        condition: "BELOW",
        targetPrice: 1600,
        currentPrice: 1500,
      })
    ).toContain("lower than the current price");
  });

  it("allows future targets and unknown current price", () => {
    expect(
      getInvalidPriceAlertTargetMessage({
        condition: "ABOVE",
        targetPrice: 1600,
        currentPrice: 1500,
      })
    ).toBeNull();

    expect(
      getInvalidPriceAlertTargetMessage({
        condition: "BELOW",
        targetPrice: 1400,
        currentPrice: 1500,
      })
    ).toBeNull();

    expect(
      getInvalidPriceAlertTargetMessage({
        condition: "ABOVE",
        targetPrice: 1600,
      })
    ).toBeNull();
  });

  // Mirrors the scanner UI's own test matrix (ABCOTS · BSE, current
  // ₹209.90) so the two stay in sync if either changes.
  describe("ABCOTS/BSE example (current 209.90)", () => {
    const currentPrice = 209.9;

    it("case A: Above 250 is valid", () => {
      expect(
        getInvalidPriceAlertTargetMessage({ condition: "ABOVE", targetPrice: 250, currentPrice })
      ).toBeNull();
    });

    it("case B: Above 44 is blocked (already satisfied)", () => {
      expect(
        getInvalidPriceAlertTargetMessage({ condition: "ABOVE", targetPrice: 44, currentPrice })
      ).not.toBeNull();
    });

    it("case C: Below 44 is valid", () => {
      expect(
        getInvalidPriceAlertTargetMessage({ condition: "BELOW", targetPrice: 44, currentPrice })
      ).toBeNull();
    });

    it("case D: Below 250 is blocked (already satisfied)", () => {
      expect(
        getInvalidPriceAlertTargetMessage({ condition: "BELOW", targetPrice: 250, currentPrice })
      ).not.toBeNull();
    });

    it("case G: switching condition on the same target flips validity immediately", () => {
      // Same call, condition is the only thing that changes - this is the
      // exact reactivity the UI's memo depends on (condition, target, and
      // current price are the only three inputs).
      expect(
        getInvalidPriceAlertTargetMessage({ condition: "ABOVE", targetPrice: 44, currentPrice })
      ).not.toBeNull();
      expect(
        getInvalidPriceAlertTargetMessage({ condition: "BELOW", targetPrice: 44, currentPrice })
      ).toBeNull();
    });
  });
});