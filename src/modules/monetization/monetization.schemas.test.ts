import { describe, expect, it } from "vitest";

import {
  adPlacementKeyParamsSchema,
  updateAdPlacementBodySchema,
  updateMonetizationSettingsBodySchema,
} from "./monetization.schemas";

describe("updateMonetizationSettingsBodySchema", () => {
  it("accepts a valid live config", () => {
    const result = updateMonetizationSettingsBodySchema.safeParse({
      mode: "live",
      publisherId: "ca-pub-1234567890123456",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.publisherId).toBe("ca-pub-1234567890123456");
  });

  it("accepts off mode with a null publisher id", () => {
    const result = updateMonetizationSettingsBodySchema.safeParse({
      mode: "off",
      publisherId: null,
    });
    expect(result.success).toBe(true);
  });

  it("clears an empty-string publisher id to null rather than rejecting it", () => {
    const result = updateMonetizationSettingsBodySchema.safeParse({
      mode: "off",
      publisherId: "",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.publisherId).toBeNull();
  });

  it("rejects a malformed publisher id", () => {
    const result = updateMonetizationSettingsBodySchema.safeParse({
      mode: "live",
      publisherId: "not-a-publisher-id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown mode", () => {
    const result = updateMonetizationSettingsBodySchema.safeParse({
      mode: "enabled",
      publisherId: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra/unknown fields (strict body)", () => {
    const result = updateMonetizationSettingsBodySchema.safeParse({
      mode: "off",
      publisherId: null,
      userId: "should-not-be-accepted",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateAdPlacementBodySchema", () => {
  it("accepts enabled=true with a valid numeric slot id", () => {
    const result = updateAdPlacementBodySchema.safeParse({ enabled: true, slotId: "123456789" });
    expect(result.success).toBe(true);
  });

  it("accepts enabled=true with a missing slot id - not a save-time hard error", () => {
    const result = updateAdPlacementBodySchema.safeParse({ enabled: true, slotId: null });
    expect(result.success).toBe(true);
  });

  it("rejects a non-numeric slot id", () => {
    const result = updateAdPlacementBodySchema.safeParse({ enabled: true, slotId: "abc" });
    expect(result.success).toBe(false);
  });
});

describe("adPlacementKeyParamsSchema", () => {
  it("accepts a known placement key", () => {
    expect(adPlacementKeyParamsSchema.safeParse({ key: "landing_primary" }).success).toBe(true);
  });

  it("rejects an unknown placement key - keys are a closed set, not display labels", () => {
    expect(adPlacementKeyParamsSchema.safeParse({ key: "Landing Primary" }).success).toBe(false);
    expect(adPlacementKeyParamsSchema.safeParse({ key: "made_up_key" }).success).toBe(false);
  });
});
