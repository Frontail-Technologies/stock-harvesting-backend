import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./scanner.candles", () => ({
  getScannerWeeklySeriesInput: vi.fn(),
}));

import { computeSymbolBreakoutBacktest } from "./scanner.backtest";
import { getScannerWeeklySeriesInput } from "./scanner.candles";
import { evaluateScannerWeeklySeries } from "./rules/scanner-weekly-rule";

const mockedGetScannerWeeklySeriesInput = vi.mocked(getScannerWeeklySeriesInput);

function buildWeeklyRows(weeks: number, close: (index: number) => number, offset = 0) {
  return Array.from({ length: weeks }, (_, index) => ({
    time: `w-${String(index + offset).padStart(4, "0")}`,
    close: close(index),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeSymbolBreakoutBacktest", () => {
  it("returns null when there is no usable Scanner series", async () => {
    mockedGetScannerWeeklySeriesInput.mockResolvedValueOnce(null);

    const result = await computeSymbolBreakoutBacktest("NODATA", "BSE", 50);

    expect(result).toBeNull();
  });

  it("produces a closed trade from an entry to an exit", async () => {
    const weeklyRows = buildWeeklyRows(60, (index) => {
      if (index < 30) return 500;
      if (index < 40) return 1000; // qualifies for 10 weeks
      return 500;
    });
    mockedGetScannerWeeklySeriesInput.mockResolvedValueOnce({
      segments: [weeklyRows],
      latestSegment: weeklyRows,
      isLatestWeekFresh: true,
    });

    const result = await computeSymbolBreakoutBacktest("TRADES", "BSE", 30);

    expect(result).not.toBeNull();
    expect(result?.signalsGenerated).toBeGreaterThan(0);
  });

  it("computes pass/fail using exactly the same qualification series the live Scanner uses", async () => {
    const weeklyRows = buildWeeklyRows(80, (index) => (index % 20 === 0 ? 1000 : 800));
    mockedGetScannerWeeklySeriesInput.mockResolvedValueOnce({
      segments: [weeklyRows],
      latestSegment: weeklyRows,
      isLatestWeekFresh: true,
    });

    const lookbackWeeks = 50;
    const direct = evaluateScannerWeeklySeries(weeklyRows, lookbackWeeks);
    const directSignals = direct.filter((point, index) => point.passes && !direct[index - 1]?.passes).length;

    const result = await computeSymbolBreakoutBacktest("CONSISTENT", "BSE", lookbackWeeks);

    expect(result?.signalsGenerated).toBe(directSignals);
  });

  it("evaluates each segment independently and never lets a trade cross a segment boundary", async () => {
    const lookbackWeeks = 20;
    // Segment A: 60 weeks, qualifies from index 40 onward and never exits -
    // a trade would normally still be "open" at the segment's own end.
    const segmentA = buildWeeklyRows(60, (index) => (index >= 40 ? 1000 : 500), 0);
    // Segment B: a fresh 60-week series (its own index space) that also
    // qualifies from its own index 40 onward - if segment A's still-open
    // trade were wrongly carried into segment B, the entry index used for
    // the combined trade would be wrong (or a single trade would span both).
    const segmentB = buildWeeklyRows(60, (index) => (index >= 40 ? 1000 : 500), 100);

    mockedGetScannerWeeklySeriesInput.mockResolvedValueOnce({
      segments: [segmentA, segmentB],
      latestSegment: segmentB,
      isLatestWeekFresh: true,
    });

    const result = await computeSymbolBreakoutBacktest("SEGMENTED", "BSE", lookbackWeeks);

    // Each segment independently opens exactly one still-open trade at its
    // own end (index 59 relative to its own series) - two trades total,
    // not one trade spanning both segments.
    expect(result?.signalsGenerated).toBe(2);
  });

  it("a stale/invalid latest segment still lets an earlier valid segment contribute signals", async () => {
    const lookbackWeeks = 20;
    const historicalSegment = buildWeeklyRows(60, (index) => (index >= 40 ? 1000 : 500), 0);
    const shortRecentSegment = buildWeeklyRows(5, () => 100, 200); // far too short for lookbackWeeks=20

    mockedGetScannerWeeklySeriesInput.mockResolvedValueOnce({
      segments: [historicalSegment, shortRecentSegment],
      latestSegment: shortRecentSegment,
      isLatestWeekFresh: false,
    });

    const result = await computeSymbolBreakoutBacktest("STALELATEST", "BSE", lookbackWeeks);

    expect(result).not.toBeNull();
    expect(result?.signalsGenerated).toBe(1);
  });
});
