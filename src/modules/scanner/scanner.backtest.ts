import { evaluateScannerWeeklySeries, type ScannerWeeklyCandle } from "./rules/scanner-weekly-rule";
import { getScannerWeeklySeriesInput } from "./scanner.candles";

export type SymbolBreakoutBacktestStats = {
  hitRatePct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  signalsGenerated: number;
  avgHoldingDays: number;
  largestWinnerPct: number;
  largestLoserPct: number;
};

type BreakoutTrade = { entryIndex: number; exitIndex: number; returnPct: number };

export async function computeSymbolBreakoutBacktest(
  symbol: string,
  exchange: string,
  lookbackWeeks: number
): Promise<SymbolBreakoutBacktestStats | null> {
  const seriesInput = await getScannerWeeklySeriesInput(symbol, exchange);
  if (!seriesInput) return null;

  const trades: BreakoutTrade[] = [];
  for (const segment of seriesInput.segments) {
    trades.push(...buildBreakoutTradesForSegment(segment, lookbackWeeks));
  }

  const signalsGenerated = trades.length;
  if (trades.length === 0) return null;

  const winners = trades.filter((trade) => trade.returnPct > 0);
  const losers = trades.filter((trade) => trade.returnPct <= 0);

  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equity *= 1 + trade.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  const grossProfit = winners.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.returnPct, 0));

  return {
    hitRatePct: (winners.length / trades.length) * 100,
    totalReturnPct: equity - 100,
    maxDrawdownPct,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    signalsGenerated,
    avgHoldingDays:
      trades.reduce((sum, trade) => sum + (trade.exitIndex - trade.entryIndex) * 7, 0) / trades.length,
    largestWinnerPct: Math.max(...trades.map((trade) => trade.returnPct)),
    largestLoserPct: Math.min(...trades.map((trade) => trade.returnPct)),
  };
}

function buildBreakoutTradesForSegment(
  weeklyRows: ScannerWeeklyCandle[],
  lookbackWeeks: number
): BreakoutTrade[] {
  const seriesPoints = evaluateScannerWeeklySeries(weeklyRows, lookbackWeeks);
  const matched: boolean[] = seriesPoints.map((point) => point.passes);

  const trades: BreakoutTrade[] = [];
  let entryIndex: number | null = null;

  for (let index = 0; index < weeklyRows.length; index++) {
    const isMatched = matched[index];
    const wasMatched = index > 0 && matched[index - 1];

    if (isMatched && !wasMatched) {
      entryIndex = index;
    } else if (!isMatched && wasMatched && entryIndex !== null) {
      trades.push(buildBreakoutTrade(entryIndex, index, weeklyRows));
      entryIndex = null;
    }
  }

  if (entryIndex !== null) {
    trades.push(buildBreakoutTrade(entryIndex, weeklyRows.length - 1, weeklyRows));
  }

  return trades;
}

function buildBreakoutTrade(
  entryIndex: number,
  exitIndex: number,
  rows: ScannerWeeklyCandle[]
): BreakoutTrade {
  const entryClose = rows[entryIndex].close;
  const exitClose = rows[exitIndex].close;
  return {
    entryIndex,
    exitIndex,
    returnPct: ((exitClose - entryClose) / entryClose) * 100,
  };
}
