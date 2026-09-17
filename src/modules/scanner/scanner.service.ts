import {
  CANDLE_TIMEFRAME,
  DEFAULT_EXCHANGE,
  type CandleTimeframe,
} from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import { calculateNear250WeekCloseHighScan } from "./rules/near-250-week-close-high";
import { computeSymbolBreakoutBacktest } from "./scanner.backtest";
import { getScannerWeeklySeriesInput } from "./scanner.candles";
import {
  DEFAULT_SCANNER_LOOKBACK,
  SCANNER_LOOKBACK_WEEKS,
  SCANNER_RULE_KEY,
  type ScannerLookbackMultiplier,
} from "./scanner.constants";
import { findScanResultRows } from "./scanner.repository";

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
    const liveResult = await calculateCurrentNear250WeekCloseHighResult({
      ...input,
      exchange,
    });
    return liveResult ? [liveResult] : [];
  }

  const rows = await findScanResultRows({
    exchange,
    timeframe: input.timeframe,
    symbol: input.symbol ? normalizeSymbol(input.symbol) : undefined,
    rule: input.rule,
    limit: input.limit,
  });

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

async function calculateCurrentNear250WeekCloseHighResult(input: {
  symbol?: string;
  timeframe: CandleTimeframe;
  rule?: string;
  exchange: string;
  lookback?: ScannerLookbackMultiplier;
}) {
  if (!input.symbol) return null;
  if (input.timeframe !== CANDLE_TIMEFRAME.week) return null;
  if (input.rule && input.rule !== SCANNER_RULE_KEY.near250WeekCloseHigh) return null;

  const symbol = normalizeSymbol(input.symbol);
  const seriesInput = await getScannerWeeklySeriesInput(symbol, input.exchange);
  if (!seriesInput) return null;

  const lookback = input.lookback ?? DEFAULT_SCANNER_LOOKBACK;
  const lookbackWeeks = SCANNER_LOOKBACK_WEEKS[lookback];
  const scan = calculateNear250WeekCloseHighScan(
    seriesInput.segments,
    seriesInput.latestSegment,
    seriesInput.isLatestWeekFresh,
    lookbackWeeks
  );

  if (!scan) return null;

  return {
    id: `${SCANNER_RULE_KEY.near250WeekCloseHigh}:${input.exchange}:${symbol}:${lookback}:${scan.endTime}`,
    ruleKey: SCANNER_RULE_KEY.near250WeekCloseHigh,
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


