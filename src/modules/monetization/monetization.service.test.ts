import { describe, expect, it } from "vitest";

import {
  buildPublicMonetizationConfig,
  isPlacementRenderable,
  isValidPublisherId,
  isValidSlotId,
} from "./monetization.service";

describe("isValidPublisherId", () => {
  it("accepts a well-formed AdSense publisher id", () => {
    expect(isValidPublisherId("ca-pub-1234567890123456")).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isValidPublisherId("pub-1234567890123456")).toBe(false);
    expect(isValidPublisherId("ca-pub-abc")).toBe(false);
    expect(isValidPublisherId("")).toBe(false);
    expect(isValidPublisherId("ca-pub-")).toBe(false);
  });
});

describe("isValidSlotId", () => {
  it("accepts a numeric slot id", () => {
    expect(isValidSlotId("123456789")).toBe(true);
  });

  it("rejects non-numeric or empty values", () => {
    expect(isValidSlotId("")).toBe(false);
    expect(isValidSlotId("abc123")).toBe(false);
    expect(isValidSlotId("12")).toBe(false); // shorter than the 6-digit floor
  });
});

// This is the rule the plan/brief calls "canRenderAd" - mirrored on the
// frontend for actual rendering decisions. Here it only decides what the
// admin UI reports as a placement's "ready"/"renderable" status, but the
// three-mode behavior must match exactly.
describe("isPlacementRenderable", () => {
  const readyPlacement = { enabled: true, slotId: "123456789" };

  it("OFF: never renderable regardless of configuration", () => {
    expect(isPlacementRenderable("off", "ca-pub-1234567890123456", readyPlacement)).toBe(false);
    expect(isPlacementRenderable("off", null, { enabled: false, slotId: null })).toBe(false);
  });

  it("PREVIEW: renderable exactly when the placement itself is enabled, publisher/slot irrelevant", () => {
    expect(isPlacementRenderable("preview", null, readyPlacement)).toBe(true);
    expect(isPlacementRenderable("preview", null, { enabled: false, slotId: null })).toBe(false);
  });

  it("LIVE: requires publisherId AND enabled AND slotId together", () => {
    expect(isPlacementRenderable("live", "ca-pub-1234567890123456", readyPlacement)).toBe(true);
    expect(isPlacementRenderable("live", null, readyPlacement)).toBe(false);
    expect(
      isPlacementRenderable("live", "ca-pub-1234567890123456", { enabled: false, slotId: "123456789" })
    ).toBe(false);
    expect(
      isPlacementRenderable("live", "ca-pub-1234567890123456", { enabled: true, slotId: null })
    ).toBe(false);
  });
});

describe("buildPublicMonetizationConfig", () => {
  it("keys placements by their stable key, not display label", () => {
    const config = buildPublicMonetizationConfig(
      { mode: "live", publisherId: "ca-pub-1234567890123456" },
      [
        { key: "landing_primary", enabled: true, slotId: "111111111" },
        { key: "landing_secondary", enabled: false, slotId: null },
        { key: "scanner_bottom", enabled: true, slotId: "222222222" },
      ]
    );

    expect(config).toEqual({
      mode: "live",
      publisherId: "ca-pub-1234567890123456",
      placements: {
        landing_primary: { enabled: true, slotId: "111111111" },
        landing_secondary: { enabled: false, slotId: null },
        scanner_bottom: { enabled: true, slotId: "222222222" },
      },
    });
  });

  it("carries mode/publisherId through unchanged, including OFF with no publisher", () => {
    const config = buildPublicMonetizationConfig({ mode: "off", publisherId: null }, []);
    expect(config.mode).toBe("off");
    expect(config.publisherId).toBeNull();
    expect(config.placements).toEqual({});
  });
});
