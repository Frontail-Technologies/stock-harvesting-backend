import { beforeEach, describe, expect, it, vi } from "vitest";

const scannerMocks = vi.hoisted(() => ({
  getScannerWeeklySeriesInput: vi.fn(),
  calculateNear250WeekCloseHighScan: vi.fn(),
  resolveLiveScannerSignalFromDailyCloses: vi.fn(),
}));

vi.mock("./scanner.candles", () => ({
  getScannerWeeklySeriesInput: scannerMocks.getScannerWeeklySeriesInput,
}));

vi.mock("./rules/near-250-week-close-high", () => ({
  calculateNear250WeekCloseHighScan: scannerMocks.calculateNear250WeekCloseHighScan,
}));

vi.mock("./scanner-current-signal", () => ({
  resolveLiveScannerSignalFromDailyCloses: scannerMocks.resolveLiveScannerSignalFromDailyCloses,
}));

import { listScannerResults, toClientScanMetrics } from "./scanner.service";

beforeEach(() => {
  vi.clearAllMocks();
});

// API response minimization (docs/DOMAIN_BOUNDARIES.md) - locks in that
// the scanner results API never forwards calculateNear250WeekCloseHighScan's
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

describe("listScannerResults - current-week highlight", () => {
  it("does not extend last week's PASS highlight when the live signal is now Out", async () => {
    const dailyCloses = [{ time: "2026-09-25", close: 500 }];
    scannerMocks.getScannerWeeklySeriesInput.mockResolvedValue({
      segments: [[{ time: "2026-09-18", close: 1000 }]],
      latestSegment: [{ time: "2026-09-18", close: 1000 }],
      isLatestWeekFresh: true,
      dailyCloses,
    });
    scannerMocks.calculateNear250WeekCloseHighScan.mockReturnValue({
      matched: true,
      startTime: "2026-09-18",
      endTime: "2026-09-18",
      highlightTimes: ["2026-09-18"],
      metrics: { lookbackWeeks: 50 },
    });
    scannerMocks.resolveLiveScannerSignalFromDailyCloses.mockReturnValue({ matched: false });

    const [result] = await listScannerResults({
      symbol: "TCS",
      timeframe: "1W",
      limit: 100,
      exchange: "BSE",
      lookback: "1x",
    });

    expect(scannerMocks.resolveLiveScannerSignalFromDailyCloses).toHaveBeenCalledWith(
      dailyCloses,
      "BSE",
      50,
      { strict: true }
    );
    expect(result.metrics.latestMatched).toBe(false);
    expect(result.highlightTimes).toEqual(["2026-09-18"]);
  });
});
