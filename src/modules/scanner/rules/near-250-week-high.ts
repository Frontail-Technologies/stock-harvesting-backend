import {
  deriveScannerLookbackBars,
  evaluateWeeklyStrongSeries,
  type WeeklyStrongCandle,
} from "../../market-data/weekly-strong-evaluator";
import { getEffectiveScannerLookbackWeeks } from "../scanner.constants";
import type { Near250WeekHighScanMatch } from "../scanner.types";

// The Scanner's live near-high scan. This is now the SAME two-condition
// Weekly Strong evaluator computeSymbolBreakoutBacktest (market-data.service.ts)
// uses for the backtest overlay on the same page - previously this function
// ran its own weekly-only simplification (a single close-vs-rolling-high
// check), which could disagree with the backtest's two-condition answer for
// the same symbol at the same moment. See docs/KNOWN_ISSUES.md.
export function calculateNear250WeekHighScan(
  dailyCandles: WeeklyStrongCandle[],
  weeklyCandles: WeeklyStrongCandle[],
  requestedLookbackWeeks: number
): Near250WeekHighScanMatch | null {
  const lookbackWeeks = getEffectiveScannerLookbackWeeks(
    requestedLookbackWeeks,
    weeklyCandles.length
  );
  if (!lookbackWeeks) return null;

  const { dailyLookbackBars, weeklyLookbackBars } = deriveScannerLookbackBars(lookbackWeeks);
  const seriesPoints = evaluateWeeklyStrongSeries(dailyCandles, weeklyCandles, {
    dailyLookbackBars,
    weeklyLookbackBars,
  });
  if (seriesPoints.length === 0) return null;

  const highlightTimes = seriesPoints.filter((point) => point.passes).map((point) => point.time);
  const latest = seriesPoints[seriesPoints.length - 1];

  return {
    matched: latest.passes,
    startTime: highlightTimes[0] ?? latest.time,
    endTime: latest.time,
    highlightTimes,
    metrics: { lookbackWeeks },
  };
}
