import { describe, expect, it } from "vitest";

import { toClientScanMetrics } from "./scanner.service";

// API response minimization (docs/DOMAIN_BOUNDARIES.md) - locks in that
// the scanner results API never forwards calculateNear250WeekHighScan's
// raw diagnostic values (highestClose250, threshold85, etc.) to the
// client, only the boolean the UI actually renders. A regression here
// would make the rule's own ratio trivially recoverable from a single API
// response (threshold85 / highestClose250).
describe("toClientScanMetrics", () => {
  it("keeps only latestMatched, dropping every other field", () => {
    const raw = {
      currentClose: 123.45,
      highestClose250: 145.0,
      threshold85: 123.25,
      currentVsHighestClosePct: 85.1,
      distanceAboveThresholdPct: 0.16,
      lookbackWeeks: 250,
      latestMatched: true,
    };

    expect(toClientScanMetrics(raw)).toEqual({ latestMatched: true });
  });

  it("preserves a false latestMatched (not just truthy ones)", () => {
    expect(toClientScanMetrics({ latestMatched: false, threshold85: 1 })).toEqual({
      latestMatched: false,
    });
  });

  it("omits latestMatched entirely when it isn't a boolean on the input", () => {
    expect(toClientScanMetrics({})).toEqual({});
    expect(toClientScanMetrics({ latestMatched: "true" })).toEqual({});
    expect(toClientScanMetrics({ latestMatched: null })).toEqual({});
  });
});
