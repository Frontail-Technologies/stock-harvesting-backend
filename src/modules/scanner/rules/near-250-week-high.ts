import { getEffectiveScannerLookbackWeeks } from "../scanner.constants";
import type { Near250WeekHighScanMatch } from "../scanner.types";
import { evaluateScannerWeeklySeries, type ScannerWeeklyCandle } from "./scanner-weekly-rule";

export function calculateNear250WeekHighScan(
  segments: ScannerWeeklyCandle[][],
  latestSegment: ScannerWeeklyCandle[],
  isLatestWeekFresh: boolean,
  requestedLookbackWeeks: number
): Near250WeekHighScanMatch | null {
  const highlightTimes: string[] = [];
  for (const segment of segments) {
    for (const point of evaluateScannerWeeklySeries(segment, requestedLookbackWeeks)) {
      if (point.passes) highlightTimes.push(point.time);
    }
  }

  let matched: boolean | undefined;
  let currentLookbackWeeks: number | null = null;
  if (isLatestWeekFresh) {
    currentLookbackWeeks = getEffectiveScannerLookbackWeeks(requestedLookbackWeeks, latestSegment.length);
    if (currentLookbackWeeks) {
      const currentPoints = evaluateScannerWeeklySeries(latestSegment, currentLookbackWeeks);
      matched = currentPoints[currentPoints.length - 1]?.passes;
    }
  }

  if (highlightTimes.length === 0 && matched === undefined) return null;

  const latestTime = latestSegment[latestSegment.length - 1]?.time ?? highlightTimes[highlightTimes.length - 1];

  return {
    matched,
    startTime: highlightTimes[0] ?? latestTime,
    endTime: latestTime,
    highlightTimes,
    metrics: { lookbackWeeks: currentLookbackWeeks },
  };
}
