import {
  NEAR_250_WEEK_HIGH_RULE,
  getEffectiveScannerLookbackWeeks,
} from "../scanner.constants";
import type { Near250WeekHighScanMatch, ScannerCandle } from "../scanner.types";

export function calculateNear250WeekHighScan(
  candles: ScannerCandle[],
  requestedLookbackWeeks: number
): Near250WeekHighScanMatch | null {
  const sortedCandles = [...candles].sort((a, b) => a.time.localeCompare(b.time));
  const lookbackWeeks = getEffectiveScannerLookbackWeeks(
    requestedLookbackWeeks,
    sortedCandles.length
  );
  if (!lookbackWeeks) return null;

  const latestWindow = sortedCandles.slice(-lookbackWeeks);
  const latest = latestWindow[latestWindow.length - 1];
  const highestHigh250 = Math.max(...latestWindow.map((candle) => candle.high));
  const threshold85 = highestHigh250 * NEAR_250_WEEK_HIGH_RULE.thresholdMultiplier;
  const currentClose = latest.close;
  const matched = currentClose >= threshold85;
  const currentVsHighPct = (currentClose / highestHigh250) * 100;
  const distanceAboveThresholdPct = ((currentClose - threshold85) / threshold85) * 100;
  const highlightTimes = getRollingHighlightTimes(sortedCandles, lookbackWeeks);

  if (!matched) {
    return {
      matched,
      startTime: highlightTimes[0] ?? latest.time,
      endTime: latest.time,
      highlightTimes,
      metrics: {
        currentClose,
        highestHigh250,
        threshold85,
        currentVsHighPct,
        distanceAboveThresholdPct,
        lookbackWeeks,
      },
    };
  }

  return {
    matched,
    startTime: highlightTimes[0] ?? latest.time,
    endTime: latest.time,
    highlightTimes,
    metrics: {
      currentClose,
      highestHigh250,
      threshold85,
      currentVsHighPct,
      distanceAboveThresholdPct,
      lookbackWeeks,
    },
  };
}

function getRollingHighlightTimes(candles: ScannerCandle[], lookbackWeeks: number) {
  const highlightTimes: string[] = [];

  for (let index = lookbackWeeks - 1; index < candles.length; index++) {
    const window = candles.slice(index - lookbackWeeks + 1, index + 1);
    const highestHigh = Math.max(...window.map((candle) => candle.high));
    const threshold = highestHigh * NEAR_250_WEEK_HIGH_RULE.thresholdMultiplier;
    const candle = candles[index];

    if (candle.close >= threshold) {
      highlightTimes.push(candle.time);
    }
  }

  return highlightTimes;
}
