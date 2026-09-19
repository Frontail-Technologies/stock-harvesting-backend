import { excludeIncompleteTradingWeek } from "../market-data/weekly-strong-evaluator";
import { evaluateScannerWeeklySeries, type ScannerWeeklyCandle } from "./rules/scanner-weekly-rule";
import { classifyScannerWeeklySeries } from "./rules/scanner-weekly-series-safety";
import { deriveScannerWeeklyCloses } from "./scanner.candles";
import { getEffectiveScannerLookbackWeeks } from "./scanner.constants";
import type { ScannerDailyClose } from "../market-data/market-data.candles";

export type CurrentScannerSignal = {
  matched: boolean;
  effectiveLookbackWeeks: number | null;
  currentTime: string | null;
  currentClose: number | null;
  entryTime: string | null;
  entryClose: number | null;
  previousWeekMatched: boolean | null;
  previousWeekTime: string | null;
};

const EMPTY_SIGNAL: CurrentScannerSignal = {
  matched: false,
  effectiveLookbackWeeks: null,
  currentTime: null,
  currentClose: null,
  entryTime: null,
  entryClose: null,
  previousWeekMatched: null,
  previousWeekTime: null,
};

export function resolveCurrentScannerSignal(
  latestSegment: ScannerWeeklyCandle[],
  isLatestWeekFresh: boolean,
  requestedLookbackWeeks: number,
  options: { strict?: boolean } = {}
): CurrentScannerSignal {
  if (!isLatestWeekFresh || latestSegment.length === 0) return EMPTY_SIGNAL;

  const current = latestSegment[latestSegment.length - 1];
  const effectiveLookbackWeeks = getEffectiveScannerLookbackWeeks(
    requestedLookbackWeeks,
    latestSegment.length,
    options
  );
  if (!effectiveLookbackWeeks) {
    return { ...EMPTY_SIGNAL, currentTime: current.time, currentClose: current.close };
  }

  const points = evaluateScannerWeeklySeries(latestSegment, effectiveLookbackWeeks);
  const matched = points[points.length - 1]?.passes === true;
  const previousPoint = points.length >= 2 ? points[points.length - 2] : null;

  if (!matched) {
    return {
      matched: false,
      effectiveLookbackWeeks,
      currentTime: current.time,
      currentClose: current.close,
      entryTime: null,
      entryClose: null,
      previousWeekMatched: previousPoint?.passes ?? null,
      previousWeekTime: previousPoint?.time ?? null,
    };
  }

  let index = points.length - 1;
  while (index > 0 && points[index - 1].passes) index--;

  return {
    matched: true,
    effectiveLookbackWeeks,
    currentTime: current.time,
    currentClose: current.close,
    entryTime: latestSegment[index].time,
    entryClose: latestSegment[index].close,
    previousWeekMatched: previousPoint?.passes ?? null,
    previousWeekTime: previousPoint?.time ?? null,
  };
}

// Same chain as resolveScannerSignalFromDailyCloses, except the still-forming
// current week is kept as the latest weekly candle (its close is the latest
// daily close so far) instead of being dropped - so "current" is where the
// stock stands right now and "previous" is the last COMPLETED week. Freshness
// is unchanged: a symbol whose latest daily row is older than the last completed
// week still resolves to no signal. When no current-week row exists yet, the
// latest weekly candle is simply the last completed week.
export function resolveLiveScannerSignalFromDailyCloses(
  dailyCloses: ScannerDailyClose[],
  exchange: string,
  requestedLookbackWeeks: number
): CurrentScannerSignal {
  const weeklyCloses = deriveScannerWeeklyCloses(dailyCloses);
  if (weeklyCloses.length === 0) return EMPTY_SIGNAL;

  const { latestSegment, isLatestWeekFresh } = classifyScannerWeeklySeries(weeklyCloses, exchange);
  return resolveCurrentScannerSignal(latestSegment, isLatestWeekFresh, requestedLookbackWeeks);
}

export function resolveScannerSignalFromDailyCloses(
  dailyCloses: ScannerDailyClose[],
  exchange: string,
  requestedLookbackWeeks: number
): CurrentScannerSignal {
  const weeklyCloses = deriveScannerWeeklyCloses(dailyCloses);
  const completedWeeklyRows = excludeIncompleteTradingWeek(weeklyCloses, exchange);
  if (completedWeeklyRows.length === 0) return EMPTY_SIGNAL;

  const { latestSegment, isLatestWeekFresh } = classifyScannerWeeklySeries(completedWeeklyRows, exchange);
  return resolveCurrentScannerSignal(latestSegment, isLatestWeekFresh, requestedLookbackWeeks);
}
