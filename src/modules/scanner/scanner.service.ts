import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { scanResults } from "../../db/schema";
import {
  CANDLE_TIMEFRAME,
  DEFAULT_EXCHANGE,
  type CandleTimeframe,
} from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import {
  computeSymbolBreakoutBacktest,
  getSymbolWeeklyStrongSeriesInput,
} from "../market-data/market-data.service";
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
    metrics: toClientScanMetrics(result.metrics),
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
  // Same fetch+gate (daily+weekly series, completed-week trim, minimum-
  // history check) the backtest overlay uses for this same symbol - see
  // getSymbolWeeklyStrongSeriesInput's own comment for why this must be
  // shared rather than each path querying independently.
  const seriesInput = await getSymbolWeeklyStrongSeriesInput(symbol, input.exchange);
  if (!seriesInput) return null;

  const lookback = input.lookback ?? DEFAULT_SCANNER_LOOKBACK;
  const lookbackWeeks = SCANNER_LOOKBACK_WEEKS[lookback];
  const scan = calculateNear250WeekHighScan(
    seriesInput.dailyRows,
    seriesInput.weeklyRows,
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
    metrics: { latestMatched: scan.matched },
  };
}

// API response minimization (see docs/DOMAIN_BOUNDARIES.md) - the client
// only ever renders `latestMatched` (see
// src/features/scanner/lib/scanner-result-mappers.ts), never any other
// field of what the evaluator computes internally (lookback window size,
// per-bar pass/fail breakdown, etc.) - those would make the rule's own
// mechanics reverse-engineerable from API responses, so only the single
// boolean the UI renders is forwarded.
export function toClientScanMetrics(metrics: Record<string, unknown>): { latestMatched?: boolean } {
  return typeof metrics.latestMatched === "boolean"
    ? { latestMatched: metrics.latestMatched }
    : {};
}


