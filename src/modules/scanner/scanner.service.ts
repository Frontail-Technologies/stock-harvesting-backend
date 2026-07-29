import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { candles, scanResults } from "../../db/schema";
import {
  CANDLE_TIMEFRAME,
  DEFAULT_EXCHANGE,
  type CandleTimeframe,
} from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import { computeSymbolBreakoutBacktest } from "../market-data/market-data.service";
import { calculateNear250WeekHighScan } from "./rules/near-250-week-high";
import {
  DEFAULT_SCANNER_LOOKBACK,
  SCANNER_LOOKBACK_WEEKS,
  SCANNER_RULE_KEY,
  type ScannerLookbackMultiplier,
} from "./scanner.constants";

export async function listScannerResults(input: {
  symbol?: string;
  timeframe: CandleTimeframe;
  rule?: string;
  limit: number;
  exchange?: string;
  lookback?: ScannerLookbackMultiplier;
}) {
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  if (input.symbol) {
    const liveResult = await calculateCurrentNear250WeekHighResult({
      ...input,
      exchange,
    });
    return liveResult ? [liveResult] : [];
  }

  const filters = [
    eq(scanResults.exchange, exchange),
    eq(scanResults.timeframe, input.timeframe),
    input.symbol ? eq(scanResults.symbol, normalizeSymbol(input.symbol)) : undefined,
    input.rule ? eq(scanResults.ruleKey, input.rule) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select()
    .from(scanResults)
    .where(and(...filters))
    .orderBy(desc(scanResults.createdAt))
    .limit(input.limit);

  const savedResults = rows.map((result) => ({
    id: result.id,
    ruleKey: result.ruleKey,
    exchange: result.exchange,
    symbol: result.symbol,
    timeframe: result.timeframe,
    startTime: result.startTime,
    endTime: result.endTime,
    highlightTimes: result.highlightTimes,
    metrics: result.metrics,
  }));

  if (savedResults.length > 0) return savedResults;
  return [];
}

export async function getScannerBacktest(input: {
  symbol: string;
  exchange: string;
  lookback: ScannerLookbackMultiplier;
}) {
  return computeSymbolBreakoutBacktest(
    input.symbol,
    input.exchange,
    SCANNER_LOOKBACK_WEEKS[input.lookback]
  );
}

async function calculateCurrentNear250WeekHighResult(input: {
  symbol?: string;
  timeframe: CandleTimeframe;
  rule?: string;
  exchange: string;
  lookback?: ScannerLookbackMultiplier;
}) {
  if (!input.symbol) return null;
  if (input.timeframe !== CANDLE_TIMEFRAME.week) return null;
  if (input.rule && input.rule !== SCANNER_RULE_KEY.near250WeekHigh) return null;

  const symbol = normalizeSymbol(input.symbol);
  const weeklyCandles = await db
    .select({
      time: candles.time,
      high: candles.high,
      close: candles.close,
    })
    .from(candles)
    .where(
      and(
        eq(candles.exchange, input.exchange),
        eq(candles.symbol, symbol),
        eq(candles.timeframe, CANDLE_TIMEFRAME.week)
      )
    )
    .orderBy(asc(candles.time));

  const lookback = input.lookback ?? DEFAULT_SCANNER_LOOKBACK;
  const lookbackWeeks = SCANNER_LOOKBACK_WEEKS[lookback];
  const scan = calculateNear250WeekHighScan(
    weeklyCandles.map((candle) => ({
      time: candle.time,
      high: Number(candle.high),
      close: Number(candle.close),
    })),
    lookbackWeeks
  );

  if (!scan || scan.highlightTimes.length === 0) return null;

  return {
    id: `${SCANNER_RULE_KEY.near250WeekHigh}:${input.exchange}:${symbol}:${lookback}:${scan.endTime}`,
    ruleKey: SCANNER_RULE_KEY.near250WeekHigh,
    exchange: input.exchange,
    symbol,
    timeframe: CANDLE_TIMEFRAME.week,
    startTime: scan.startTime,
    endTime: scan.endTime,
    highlightTimes: scan.highlightTimes,
    metrics: {
      ...scan.metrics,
      latestMatched: scan.matched,
    },
  };
}
