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
  // strict: true - this is the Scanner's own on-demand 1x/3x/5x chart
  // lookback (see getEffectiveScannerLookbackWeeks), which must honor
  // exactly what the user selected or show nothing for that tier, unlike
  // the Dashboard Weekly Strong harvest path that still falls back to a
  // smaller tier for a recently-listed symbol.
  const highlightTimes: string[] = [];
  for (const segment of segments) {
    const segmentLookbackWeeks = getEffectiveScannerLookbackWeeks(requestedLookbackWeeks, segment.length, {
      strict: true,
    });
    if (!segmentLookbackWeeks) continue;
    for (const point of evaluateScannerWeeklySeries(segment, segmentLookbackWeeks)) {
      if (point.passes) highlightTimes.push(point.time);
    }
  }

  const signal = resolveCurrentScannerSignal(latestSegment, isLatestWeekFresh, requestedLookbackWeeks, {
    strict: true,
  });
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
