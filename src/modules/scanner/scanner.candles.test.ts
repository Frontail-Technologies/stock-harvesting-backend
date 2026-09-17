import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../market-data/market-data.candles", async () => {
  const actual =
    await vi.importActual<typeof import("../market-data/market-data.candles")>(
      "../market-data/market-data.candles"
    );
  return { ...actual, readScannerDailyCloses: vi.fn() };
});

vi.mock("../market-data/market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn(),
}));

import { aggregateWeeklyCandles } from "../market-data/candle-aggregation";
import * as candlesModule from "../market-data/market-data.candles";
import * as instrumentsModule from "../market-data/market-data.instruments";
import { getIsoWeekRange, resolveLatestCompletedWeekEnding } from "../market-data/trading-calendar";
import { evaluateScannerWeeklySeries } from "./rules/scanner-weekly-rule";
import { calculateNear250WeekCloseHighScan } from "./rules/near-250-week-close-high";
import { deriveScannerWeeklyCloses, getScannerWeeklySeriesInput } from "./scanner.candles";

const readScannerDailyCloses = vi.mocked(candlesModule.readScannerDailyCloses);
const getInstrumentsBySymbol = vi.mocked(instrumentsModule.getInstrumentsBySymbol);

// Anchored to the real, current latest completed trading week (not a fixed
// calendar date) so these tests stay correct on whatever day they run.
const LATEST_COMPLETED_MONDAY = getIsoWeekRange(resolveLatestCompletedWeekEnding("BSE")).start;

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekMonday(weekIndex: number, weekCount: number): string {
  const weeksFromLatest = weekCount - 1 - weekIndex;
  return addDays(LATEST_COMPLETED_MONDAY, -weeksFromLatest * 7);
}

function buildDailyRow(time: string) {
  return { time, close: 100 };
}

function buildFullWeeks(
  weekCount: number,
  options: { skipWeekIndex?: number; partialWeekIndex?: number; sessionsInPartialWeek?: number } = {}
) {
  const rows = [];
  for (let weekIndex = 0; weekIndex < weekCount; weekIndex++) {
    if (weekIndex === options.skipWeekIndex) continue;

    const monday = weekMonday(weekIndex, weekCount);
    const sessionsThisWeek =
      weekIndex === options.partialWeekIndex ? (options.sessionsInPartialWeek ?? 1) : 5;
    for (let day = 0; day < sessionsThisWeek; day++) {
      rows.push(buildDailyRow(addDays(monday, day)));
    }
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  getInstrumentsBySymbol.mockImplementation(async (symbols) =>
    new Map(symbols.map((symbol) => [symbol, { id: `id-${symbol}` } as never]))
  );
});

describe("getScannerWeeklySeriesInput", () => {
  it("fetches without any lower date bound - no 30-year (or any other) default history window", async () => {
    readScannerDailyCloses.mockResolvedValueOnce(buildFullWeeks(30));

    await getScannerWeeklySeriesInput("NOBOUND", "BSE");

    expect(readScannerDailyCloses).toHaveBeenCalledWith({ instrumentId: "id-NOBOUND" });
  });

  it("preserves a symbol's entire available history for historical-band warm-up - long history isn't truncated", async () => {
    const weekCount = 300; // deeper than any single Scanner tier (max 250)
    readScannerDailyCloses.mockResolvedValueOnce(buildFullWeeks(weekCount));

    const result = await getScannerWeeklySeriesInput("DEEP", "BSE");

    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("returns null when the instrument doesn't exist", async () => {
    getInstrumentsBySymbol.mockResolvedValueOnce(new Map());

    const result = await getScannerWeeklySeriesInput("UNKNOWN", "BSE");

    expect(result).toBeNull();
  });

  it("returns null when there is no candle history at all", async () => {
    readScannerDailyCloses.mockResolvedValue([]);

    const result = await getScannerWeeklySeriesInput("NODATA", "BSE");

    expect(result).toBeNull();
  });

  it("fresh consecutive completed weeks with full sessions evaluate normally as one segment", async () => {
    const weekCount = 30;
    readScannerDailyCloses.mockResolvedValueOnce(buildFullWeeks(weekCount));

    const result = await getScannerWeeklySeriesInput("FRESH", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.latestSegment).toHaveLength(weekCount);
    expect(result?.isLatestWeekFresh).toBe(true);
  });

  it("a complete 5-session week is usable, as before", async () => {
    const weekCount = 30;
    readScannerDailyCloses.mockResolvedValueOnce(buildFullWeeks(weekCount));

    const result = await getScannerWeeklySeriesInput("FIVESESSION", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("a fully missing completed week splits the history into two independent segments, neither discarded", async () => {
    const weekCount = 40;
    const gapWeekIndex = 10;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { skipWeekIndex: gapWeekIndex })
    );

    const result = await getScannerWeeklySeriesInput("GAPPY", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(2);
    expect(result?.segments[0]).toHaveLength(gapWeekIndex);
    expect(result?.segments[1]).toHaveLength(weekCount - gapWeekIndex - 1);
    expect(result?.latestSegment).toBe(result?.segments[1]);
    expect(result?.latestSegment[0].time).toBe(weekMonday(gapWeekIndex + 1, weekCount));
  });

  it("a completed week derived from only 1 daily session stays in the same segment - continuity is not broken", async () => {
    const weekCount = 40;
    const partialWeekIndex = 10;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex, sessionsInPartialWeek: 1 })
    );

    const result = await getScannerWeeklySeriesInput("PARTIAL", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("a completed week derived from only 2 daily sessions stays in the same segment - continuity is not broken", async () => {
    const weekCount = 40;
    const partialWeekIndex = 10;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex, sessionsInPartialWeek: 2 })
    );

    const result = await getScannerWeeklySeriesInput("PARTIAL2", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("a completed week derived from 4 daily sessions stays in the same segment - continuity is not broken", async () => {
    const weekCount = 40;
    const partialWeekIndex = 10;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex, sessionsInPartialWeek: 4 })
    );

    const result = await getScannerWeeklySeriesInput("PARTIAL4", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("a holiday-shortened week with 3 daily sessions is not treated as a gap - one segment", async () => {
    const weekCount = 30;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex: 5, sessionsInPartialWeek: 3 })
    );

    const result = await getScannerWeeklySeriesInput("HOLIDAY", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("the latest completed week being derived from just 1 daily session still participates as current - not suppressed", async () => {
    const weekCount = 40;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex: weekCount - 1, sessionsInPartialWeek: 1 })
    );

    const result = await getScannerWeeklySeriesInput("LATESTPARTIAL", "BSE");

    expect(result).not.toBeNull();
    expect(result?.isLatestWeekFresh).toBe(true);
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount);
  });

  it("the latest completed week being entirely missing (0 sessions) is unavailable - not silently replaced by an older week", async () => {
    const weekCount = 40;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { skipWeekIndex: weekCount - 1 })
    );

    const result = await getScannerWeeklySeriesInput("LATESTMISSING", "BSE");

    expect(result).not.toBeNull();
    expect(result?.isLatestWeekFresh).toBe(false);
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(weekCount - 1);
  });

  it("a KOTAKBANK-like missing-Monday week (only Tue+Fri sessions) does not reset a long rolling history", async () => {
    const weekCount = 260; // deeper than the 250-week (5x) tier
    const missingMondayWeekIndex = 250;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex: missingMondayWeekIndex, sessionsInPartialWeek: 2 })
    );

    const result = await getScannerWeeklySeriesInput("KOTAKLIKE", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.latestSegment).toHaveLength(weekCount);
    expect(result?.latestSegment.length).toBeGreaterThanOrEqual(250);
  });

  it("a 250-week rolling window normally spans across a partial week's own index - the peak before it still counts", async () => {
    const weekCount = 60;
    const partialWeekIndex = 30;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex, sessionsInPartialWeek: 1 })
    );

    const result = await getScannerWeeklySeriesInput("SPANPARTIAL", "BSE");
    expect(result?.segments).toHaveLength(1);

    const closes = result!.latestSegment.map((row) => row.close);
    closes[10] = 5000; // a spike well before the partial week
    const spikedSegment = result!.latestSegment.map((row, index) => ({ ...row, close: closes[index] }));

    const points = evaluateScannerWeeklySeries(spikedSegment, 50);
    const lastIndex = spikedSegment.length - 1;

    expect(points[lastIndex].passes).toBe(false); // trailing value (100) is far below the spike-driven max
  });

  it("a rolling 150-week window normally spans across a partial week's own index", async () => {
    const weekCount = 200;
    const partialWeekIndex = 150; // inside the 150-week window ending at the last index
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex, sessionsInPartialWeek: 2 })
    );

    const result = await getScannerWeeklySeriesInput("SPANPARTIAL150", "BSE");
    expect(result?.segments).toHaveLength(1);

    // Window at the last index is [50..199] - place the spike at index 100
    // (inside that window, before the partial week at index 150).
    const spiked = result!.latestSegment.map((row, index) => ({ ...row, close: index === 100 ? 5000 : row.close }));
    const points = evaluateScannerWeeklySeries(spiked, 150);
    const lastIndex = spiked.length - 1;

    // The trailing close (100) is far below 85% of the spike-driven max
    // (5000), so it fails - proving the spike at index 100 and the partial
    // week at index 150 both still count within the same 150-week window.
    expect(points[lastIndex].passes).toBe(false);
  });

  it("a rolling 250-week window normally spans across a partial week's own index", async () => {
    const weekCount = 260;
    const partialWeekIndex = 200;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { partialWeekIndex, sessionsInPartialWeek: 1 })
    );

    const result = await getScannerWeeklySeriesInput("SPANPARTIAL250", "BSE");
    expect(result?.segments).toHaveLength(1);
    expect(result?.latestSegment).toHaveLength(weekCount);

    const spiked = result!.latestSegment.map((row, index) => ({ ...row, close: index === 15 ? 5000 : row.close }));
    const points = evaluateScannerWeeklySeries(spiked, 250);
    const lastIndex = spiked.length - 1;

    // Window at the last index is [10..259] - includes the partial week at
    // index 200 and the spike at index 15, so the rolling max is still
    // driven by the spike, not reset by the partial week in between.
    expect(points[lastIndex].passes).toBe(false); // trailing close (100) is far below the spike-driven max
  });

  it("a zero-session (fully missing) week blocks the rolling max from crossing it - an earlier spike no longer counts", async () => {
    const weekCount = 60;
    const gapWeekIndex = 30;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { skipWeekIndex: gapWeekIndex })
    );

    const result = await getScannerWeeklySeriesInput("BLOCKEDBYGAP", "BSE");
    expect(result?.segments).toHaveLength(2);

    const latestSegment = result!.latestSegment; // only the weeks after the gap
    const points = evaluateScannerWeeklySeries(latestSegment, 50);

    // With every close flat at 100, and no spike present in this
    // post-gap-only segment, nothing can pass a strict > threshold.
    expect(points.every((point) => !point.passes)).toBe(true);
  });

  it("the latest week backed by just 1 session can still produce an actual current match, not just freshness", async () => {
    const weekCount = 60;
    const rows = buildFullWeeks(weekCount - 1, {});
    const latestMonday = weekMonday(weekCount - 1, weekCount);
    rows.push({ time: addDays(latestMonday, 1), close: 100 }); // 1 session, matches the flat baseline high

    readScannerDailyCloses.mockResolvedValueOnce(rows);
    const result = await getScannerWeeklySeriesInput("CURRENTMATCH", "BSE");
    expect(result?.isLatestWeekFresh).toBe(true);

    const scan = calculateNear250WeekCloseHighScan(result!.segments, result!.latestSegment, result!.isLatestWeekFresh, 50);
    expect(scan?.matched).toBe(true);
  });

  it("the latest week being entirely missing produces an unavailable current verdict via calculateNear250WeekCloseHighScan too", async () => {
    const weekCount = 60;
    readScannerDailyCloses.mockResolvedValueOnce(
      buildFullWeeks(weekCount, { skipWeekIndex: weekCount - 1 })
    );

    const result = await getScannerWeeklySeriesInput("SCANUNAVAILABLE", "BSE");
    expect(result?.isLatestWeekFresh).toBe(false);

    const scan = calculateNear250WeekCloseHighScan(result!.segments, result!.latestSegment, result!.isLatestWeekFresh, 50);
    expect(scan?.matched).toBeUndefined();
  });

  it("the incomplete, still-forming current week remains excluded, same as before", async () => {
    const weekCount = 30;
    const rows = buildFullWeeks(weekCount);
    const inProgressMonday = addDays(LATEST_COMPLETED_MONDAY, 7); // the week after the latest completed one
    rows.push({ time: addDays(inProgressMonday, 0), close: 100 });

    readScannerDailyCloses.mockResolvedValueOnce(rows);
    const result = await getScannerWeeklySeriesInput("STILLFORMING", "BSE");

    const allTimes = result?.segments.flatMap((segment) => segment.map((row) => row.time)) ?? [];
    expect(allTimes).not.toContain(inProgressMonday);
  });

  it("a partial week's weekly close is the close of the last actual daily candle in that week, never fabricated", async () => {
    const totalWeeks = 10;
    const rows = [];
    for (let weekIndex = 0; weekIndex < totalWeeks - 1; weekIndex++) {
      const monday = weekMonday(weekIndex, totalWeeks);
      for (let day = 0; day < 5; day++) {
        rows.push({ time: addDays(monday, day), close: 100 + weekIndex });
      }
    }
    const latestMonday = weekMonday(totalWeeks - 1, totalWeeks);
    rows.push({ time: addDays(latestMonday, 1), close: 999 }); // only Tuesday

    readScannerDailyCloses.mockResolvedValueOnce(rows);

    const result = await getScannerWeeklySeriesInput("LASTSESSIONCLOSE", "BSE");

    expect(result).not.toBeNull();
    const lastWeek = result?.latestSegment[result.latestSegment.length - 1];
    expect(lastWeek?.time).toBe(latestMonday);
    expect(lastWeek?.close).toBe(999);
  });

  it("a younger stock with genuinely shorter but fully valid history keeps its full segment", async () => {
    readScannerDailyCloses.mockResolvedValueOnce(buildFullWeeks(10));

    const result = await getScannerWeeklySeriesInput("YOUNG", "BSE");

    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0]).toHaveLength(10);
  });
});

describe("deriveScannerWeeklyCloses - inherits canonical weekly bucket timestamps from aggregateWeeklyCandles", () => {
  it("a complete Mon-Fri week buckets to its Monday", () => {
    const daily = [
      { time: "2026-08-24", close: 100 }, // Mon
      { time: "2026-08-25", close: 101 },
      { time: "2026-08-26", close: 102 },
      { time: "2026-08-27", close: 103 },
      { time: "2026-08-28", close: 104 }, // Fri
    ];

    const weekly = deriveScannerWeeklyCloses(daily);

    expect(weekly).toEqual([{ time: "2026-08-24", close: 104 }]);
  });

  it("Monday missing but Tue-Fri rows exist - weekly timestamp is still the Monday", () => {
    const daily = [
      { time: "2026-08-25", close: 101 }, // Tue (Mon 2026-08-24 has no candle)
      { time: "2026-08-26", close: 102 },
      { time: "2026-08-27", close: 103 },
      { time: "2026-08-28", close: 104 }, // Fri
    ];

    const weekly = deriveScannerWeeklyCloses(daily);

    expect(weekly).toEqual([{ time: "2026-08-24", close: 104 }]);
  });

  it("the first available row being Tuesday does not make weekly.time Tuesday", () => {
    // The exact reported case: 2026-08-31 (Mon) is missing, so the first
    // stored daily candle for that ISO week is 2026-09-01 (Tue).
    const daily = [{ time: "2026-09-01", close: 250 }];

    const weekly = deriveScannerWeeklyCloses(daily);

    expect(weekly).toHaveLength(1);
    expect(weekly[0].time).toBe("2026-08-31");
    expect(weekly[0].time).not.toBe("2026-09-01");
  });

  it("adjacent weeks produce the canonical Monday sequence Aug 24 -> Aug 31 -> Sep 7, even with a missing Monday in between", () => {
    const daily = [
      { time: "2026-08-24", close: 100 }, // week 1: full Mon-Fri
      { time: "2026-08-25", close: 101 },
      { time: "2026-08-26", close: 102 },
      { time: "2026-08-27", close: 103 },
      { time: "2026-08-28", close: 104 },
      { time: "2026-09-01", close: 200 }, // week 2: Mon 2026-08-31 missing
      { time: "2026-09-02", close: 201 },
      { time: "2026-09-03", close: 202 },
      { time: "2026-09-04", close: 203 },
      { time: "2026-09-07", close: 300 }, // week 3: full Mon-Fri
      { time: "2026-09-08", close: 301 },
      { time: "2026-09-09", close: 302 },
      { time: "2026-09-10", close: 303 },
      { time: "2026-09-11", close: 304 },
    ];

    const weekly = deriveScannerWeeklyCloses(daily);

    expect(weekly.map((row) => row.time)).toEqual(["2026-08-24", "2026-08-31", "2026-09-07"]);
  });

  it("scanner highlight timestamps use the normalized weekly timestamp, not the first-available daily date", () => {
    const daily = [{ time: "2026-09-01", close: 250 }]; // Mon 2026-08-31 missing
    const weekly = deriveScannerWeeklyCloses(daily);

    const scan = calculateNear250WeekCloseHighScan([weekly], weekly, true, 1);

    expect(scan?.highlightTimes).toEqual(["2026-08-31"]);
    expect(scan?.highlightTimes).not.toContain("2026-09-01");
  });

  it("does not change the Scanner qualification formula - pass/fail depends only on close values, not the bucket timestamp fix", () => {
    const weekWithMissingMonday = deriveScannerWeeklyCloses([{ time: "2026-09-01", close: 1000 }]);
    const weekWithMondayPresent = deriveScannerWeeklyCloses([{ time: "2026-08-31", close: 1000 }]);

    const passWithMissingMonday = evaluateScannerWeeklySeries(weekWithMissingMonday, 1)[0].passes;
    const passWithMondayPresent = evaluateScannerWeeklySeries(weekWithMondayPresent, 1)[0].passes;

    expect(passWithMissingMonday).toBe(passWithMondayPresent);
    expect(passWithMissingMonday).toBe(true);
  });

  it("Scanner's weekly timestamps align with the shared aggregator's own output - no independent normalization left", () => {
    const daily = [{ time: "2026-09-01", close: 424.7 }];

    const scannerWeekly = deriveScannerWeeklyCloses(daily);
    const sharedWeekly = aggregateWeeklyCandles(
      daily.map((row) => ({ time: row.time, open: row.close, high: row.close, low: row.close, close: row.close, volume: 0 }))
    );

    expect(scannerWeekly[0].time).toBe(sharedWeekly[0].time);
    expect(scannerWeekly[0].time).toBe("2026-08-31");
  });
});
