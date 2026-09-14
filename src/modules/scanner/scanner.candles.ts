import { normalizeSymbol } from "../../shared/normalize";
import { aggregateWeeklyCandles } from "../market-data/candle-aggregation";
import { readScannerDailyCloses, type ScannerDailyClose } from "../market-data/market-data.candles";
import { getInstrumentsBySymbol } from "../market-data/market-data.instruments";
import { excludeIncompleteTradingWeek } from "../market-data/weekly-strong-evaluator";
import { classifyScannerWeeklySeries } from "./rules/scanner-weekly-series-safety";
import type { ScannerWeeklyCandle } from "./rules/scanner-weekly-rule";

export type ScannerWeeklySeriesInput = {
  segments: ScannerWeeklyCandle[][];
  latestSegment: ScannerWeeklyCandle[];
  isLatestWeekFresh: boolean;
};

export function deriveScannerWeeklyCloses(dailyCloses: ScannerDailyClose[]): ScannerWeeklyCandle[] {
  const weeklyCandles = aggregateWeeklyCandles(
    dailyCloses.map((row) => ({
      time: row.time,
      open: row.close,
      high: row.close,
      low: row.close,
      close: row.close,
      volume: 0,
    }))
  );

  return weeklyCandles.map((row) => ({ time: row.time, close: row.close }));
}

export async function getScannerWeeklySeriesInput(
  symbol: string,
  exchange: string
): Promise<ScannerWeeklySeriesInput | null> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const instrument = (await getInstrumentsBySymbol([normalizedSymbol], exchange)).get(normalizedSymbol);
  if (!instrument) return null;

  const dailyCloses = await readScannerDailyCloses({ instrumentId: instrument.id });
  if (dailyCloses.length === 0) return null;

  const weeklyCloses = deriveScannerWeeklyCloses(dailyCloses);
  const completedWeeklyRows = excludeIncompleteTradingWeek(weeklyCloses, exchange);
  if (completedWeeklyRows.length === 0) return null;

  const { segments, latestSegment, isLatestWeekFresh } = classifyScannerWeeklySeries(
    completedWeeklyRows,
    exchange
  );
  if (segments.length === 0) return null;

  return { segments, latestSegment, isLatestWeekFresh };
}
