import { describe, expect, it } from "vitest";

import { normalizeBseCollectionFilename } from "./market-collections.filename";

describe("normalizeBseCollectionFilename", () => {
  it("BSE 100 - short bracket code becomes the collection code, BSE prefix stays in the name", () => {
    expect(normalizeBseCollectionFilename("BSE 100 [BSE100].csv")).toEqual({
      name: "BSE 100",
      code: "BSE100",
    });
  });

  it("BSE AUTO - bracket code stays exactly as the code", () => {
    expect(normalizeBseCollectionFilename("BSE AUTO [AUTO].csv")).toEqual({ name: "BSE AUTO", code: "AUTO" });
  });

  it("multi-word bracket content is slugified for the code, name keeps BSE and full wording", () => {
    expect(normalizeBseCollectionFilename("BSE Information Technology [BSE IT].csv")).toEqual({
      name: "BSE Information Technology",
      code: "BSE_IT",
    });
  });

  it("BSE 500 Momentum 50 example", () => {
    expect(normalizeBseCollectionFilename("BSE 500 Momentum 50 [MOME50].csv")).toEqual({
      name: "BSE 500 Momentum 50",
      code: "MOME50",
    });
  });

  it("empty bracket falls back to deriving the code from the cleaned display name, including BSE", () => {
    expect(normalizeBseCollectionFilename("BSE 250 MICROCAP [ ].csv")).toEqual({
      name: "BSE 250 MICROCAP",
      code: "BSE_250_MICROCAP",
    });
  });

  it("no bracket at all also derives the code from the cleaned display name, including BSE", () => {
    expect(normalizeBseCollectionFilename("BSE REITS and Commercial Real Estate.csv")).toEqual({
      name: "BSE REITS and Commercial Real Estate",
      code: "BSE_REITS_AND_COMMERCIAL_REAL_ESTATE",
    });
  });

  it("does NOT strip the leading BSE prefix from the display name", () => {
    const result = normalizeBseCollectionFilename("BSE 100 [BSE100].csv");
    expect(result.name).not.toBe("100");
    expect(result.name.startsWith("BSE")).toBe(true);
  });

  it("does NOT strip BSE for a plain word name either", () => {
    const result = normalizeBseCollectionFilename("BSE AUTO [AUTO].csv");
    expect(result.name).not.toBe("AUTO");
    expect(result.name).toBe("BSE AUTO");
  });

  it("uppercase .CSV extension", () => {
    expect(normalizeBseCollectionFilename("BSE AUTO [AUTO].CSV")).toEqual({ name: "BSE AUTO", code: "AUTO" });
  });

  it("mixed-case .Csv extension", () => {
    expect(normalizeBseCollectionFilename("BSE AUTO [AUTO].Csv")).toEqual({ name: "BSE AUTO", code: "AUTO" });
  });

  it("preserves supplied capitalization of the name (does not force-case BSE or the rest)", () => {
    expect(normalizeBseCollectionFilename("bse auto [auto].csv")).toEqual({ name: "bse auto", code: "AUTO" });
  });

  it("malformed source filename with a stray trailing dot after the bracket", () => {
    const result = normalizeBseCollectionFilename("[ ]..csv");
    expect(result.name).toBe("");
    expect(result.code).toBe("");
  });

  it("preserves parentheses that are not part of the trailing bracket suffix", () => {
    expect(normalizeBseCollectionFilename("BSE Auto (New) [AUTO].csv")).toEqual({
      name: "BSE Auto (New)",
      code: "AUTO",
    });
  });

  it("collapses repeated internal whitespace", () => {
    expect(normalizeBseCollectionFilename("BSE   AUTO    [AUTO].csv")).toEqual({ name: "BSE AUTO", code: "AUTO" });
  });

  it("a filename with no BSE prefix and no bracket suffix is left as-is (minus the extension)", () => {
    expect(normalizeBseCollectionFilename("Bank Nifty.csv")).toEqual({
      name: "Bank Nifty",
      code: "BANK_NIFTY",
    });
  });

  it("is deterministic - the same filename always normalizes to the same name and code", () => {
    const first = normalizeBseCollectionFilename("BSE Information Technology [BSE IT].csv");
    const second = normalizeBseCollectionFilename("BSE Information Technology [BSE IT].csv");
    expect(first).toEqual(second);
  });

  it("basename-only: a path-like input is reduced to its filename before normalizing", () => {
    expect(normalizeBseCollectionFilename("Collections/Sector/BSE AUTO [AUTO].csv")).toEqual({
      name: "BSE AUTO",
      code: "AUTO",
    });
  });
});
