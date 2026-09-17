import type { Near250WeekCloseHighScanMatch } from "../scanner.types";
import { resolveCurrentScannerSignal } from "../scanner-current-signal";
import { getEffectiveScannerLookbackWeeks } from "../scanner.constants";
import { evaluateScannerWeeklySeries, type ScannerWeeklyCandle } from "./scanner-weekly-rule";

export function calculateNear250WeekCloseHighScan(
  segments: ScannerWeeklyCandle[][],
  latestSegment: ScannerWeeklyCandle[],
  isLatestWeekFresh: boolean,
  requestedLookbackWeeks: number
): Near250WeekCloseHighScanMatch | null {
  const highlightTimes: string[] = [];
  for (const segment of segments) {
    const segmentLookbackWeeks = getEffectiveScannerLookbackWeeks(requestedLookbackWeeks, segment.length);
    if (!segmentLookbackWeeks) continue;
    for (const point of evaluateScannerWeeklySeries(segment, segmentLookbackWeeks)) {
      if (point.passes) highlightTimes.push(point.time);
    }
  }

  const signal = resolveCurrentScannerSignal(latestSegment, isLatestWeekFresh, requestedLookbackWeeks);
  const matched = isLatestWeekFresh && signal.effectiveLookbackWeeks ? signal.matched : undefined;
  const currentLookbackWeeks = signal.effectiveLookbackWeeks;

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
