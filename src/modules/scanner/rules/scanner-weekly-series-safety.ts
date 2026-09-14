import { getWeekEndingFriday, resolveLatestCompletedWeekEnding } from "../../market-data/trading-calendar";
import type { ScannerWeeklyCandle } from "./scanner-weekly-rule";

const DAYS_PER_TRADING_WEEK = 7;

function daysBetweenDates(earlier: string, later: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (new Date(`${later}T00:00:00Z`).getTime() - new Date(`${earlier}T00:00:00Z`).getTime()) / msPerDay
  );
}

function partitionOnFullyMissingWeeks<T extends ScannerWeeklyCandle>(weeklyCandles: T[]): T[][] {
  const segments: T[][] = [];
  let current: T[] = [weeklyCandles[0]];

  for (let index = 1; index < weeklyCandles.length; index++) {
    const previousWeekEnding = getWeekEndingFriday(weeklyCandles[index - 1].time);
    const weekEnding = getWeekEndingFriday(weeklyCandles[index].time);

    if (daysBetweenDates(previousWeekEnding, weekEnding) > DAYS_PER_TRADING_WEEK) {
      segments.push(current);
      current = [];
    }

    current.push(weeklyCandles[index]);
  }

  segments.push(current);
  return segments;
}

export type ScannerWeeklySeriesPartition<T extends ScannerWeeklyCandle> = {
  segments: T[][];
  latestSegment: T[];
  isLatestWeekFresh: boolean;
};

export function classifyScannerWeeklySeries<T extends ScannerWeeklyCandle>(
  weeklyCandles: T[],
  exchange: string,
  at: Date = new Date()
): ScannerWeeklySeriesPartition<T> {
  if (weeklyCandles.length === 0) {
    return { segments: [], latestSegment: [], isLatestWeekFresh: false };
  }

  const segments = partitionOnFullyMissingWeeks(weeklyCandles);
  const latestSegment = segments[segments.length - 1] ?? [];

  const latestSegmentEnding =
    latestSegment.length > 0 ? getWeekEndingFriday(latestSegment[latestSegment.length - 1].time) : null;
  const expectedLatestWeekEnding = resolveLatestCompletedWeekEnding(exchange, at);
  const isLatestWeekFresh = latestSegmentEnding !== null && latestSegmentEnding >= expectedLatestWeekEnding;

  return { segments, latestSegment, isLatestWeekFresh };
}
