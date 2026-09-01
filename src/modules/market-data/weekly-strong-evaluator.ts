// The canonical "Weekly Strong" / near-multi-year-high breakout evaluator.
//
// Consolidated into one module after an audit found the same
// two-condition decision (latest daily close within `ratio` of its
// trailing `dailyLookbackBars`-bar high, AND latest weekly close within
// `ratio` of its trailing `weeklyLookbackBars`-bar high - both windows
// inclusive of the bar being evaluated itself) was independently
// reimplemented in FOUR places in market-data.service.ts:
//   1. computeWeeklyStrongStocks           - live list, "latest" point only
//   2. computeWeeklyStrongStocksBacktest   - full historical series, fixed
//                                            250/1252-bar windows
//   3. computeSymbolBreakoutBacktest       - full historical series, single
//                                            symbol, CALLER-CHOSEN window
//                                            sizes (Scanner's lookback
//                                            multiplier) - a genuinely
//                                            different use case, kept as
//                                            its own orchestration below,
//                                            not folded into the fixed
//                                            250/1252 default
//   4. computeAllRelativeStrengthMetrics   - only the WEEKLY half, as a
//                                            pre-filter before ranking by
//                                            combinedScore - intentionally
//                                            a different (weekly-only)
//                                            decision, not the full
//                                            two-condition screen; kept
//                                            that way here too (see
//                                            passesNearHigh, used directly
//                                            by the RS pipeline instead of
//                                            the full evaluateWeeklyStrong*
//                                            functions)
//
// None of the thresholds/constants/window sizes below changed value during
// this consolidation - only their number of independent implementations.

import { isCompletedTradingWeek } from "./trading-calendar";

export type WeeklyStrongCandle = { time: string; close: number };

// Bumped only when the evaluator's actual decision logic changes -
// persisted alongside every weekly_strong_backtest_runs row so a future
// intentional change can tell which history was generated under which
// version. Deliberately just a label, not a hash of the formula/thresholds
// themselves.
export const WEEKLY_STRONG_EVALUATOR_VERSION = "weekly-strong-v1";

// Proprietary constants - unchanged values, just one definition instead of
// duplicated literals. Not re-exported through any public API response.
export const WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS = 250;
export const WEEKLY_STRONG_DAILY_LOOKBACK_BARS = 1252;
export const WEEKLY_STRONG_NEAR_HIGH_RATIO = 0.85;
// Floor below the full lookback windows above - enough of a sample that a
// symbol's own trailing close isn't trivially just its own recent close.
// This is the Weekly Strong condition's OWN minimum - deliberately
// separate from computeAllRelativeStrengthMetrics's own (54/35-bar)
// minimum, which guards that function's other metrics (55-day change,
// monthly change, MACD), not this condition, and is left exactly as-is.
export const MIN_WEEKLY_STRONG_DAILY_BARS = 50;
export const MIN_WEEKLY_STRONG_WEEKLY_BARS = 20;

export function hasSufficientWeeklyStrongHistory(
  dailyBarCount: number,
  weeklyBarCount: number
): boolean {
  return (
    dailyBarCount >= MIN_WEEKLY_STRONG_DAILY_BARS && weeklyBarCount >= MIN_WEEKLY_STRONG_WEEKLY_BARS
  );
}

// Every Weekly Strong evaluation (the live list, the backtest chart, the
// Scanner overlay) calls this on its weekly candle series BEFORE
// evaluating - drops a trailing in-progress week if the daily feed has
// already synced into the current week, so an incomplete week can never
// be evaluated as if it were a finished one, live or historical. There
// can be at most one incomplete trailing week at any time (weeks fill in
// chronological order), so this only ever needs to check the last entry.
// See trading-calendar.ts's isCompletedTradingWeek for the actual rule.
//
// Scoped deliberately to the Weekly Strong pipeline only -
// computeAllRelativeStrengthMetrics's own weekly pre-filter (which powers
// the separate, unchanged Relative Strength Index/Sector/Industry cards)
// does not call this; that calculation path is explicitly out of scope
// here.
export function excludeIncompleteTradingWeek<T extends { time: string }>(
  weeklyRows: T[],
  exchange: string,
  at: Date = new Date()
): T[] {
  if (weeklyRows.length === 0) return weeklyRows;
  const last = weeklyRows[weeklyRows.length - 1];
  return isCompletedTradingWeek(last.time, exchange, at) ? weeklyRows : weeklyRows.slice(0, -1);
}

// Sliding-window maximum: result[i] = max(values[i - windowSize + 1 .. i]),
// inclusive of the bar at i itself. Moved here unchanged from
// market-data.service.ts's original rollingMax - used by the series
// evaluators below (computeWeeklyStrongStocksBacktest/
// computeSymbolBreakoutBacktest's replacements), which need every index's
// value in O(n) total rather than one index at a time.
export function rollingMax(values: number[], windowSize: number): number[] {
  const result = new Array<number>(values.length);
  const deque: number[] = [];

  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) {
      deque.pop();
    }
    deque.push(i);

    const windowStart = i - windowSize + 1;
    while (deque[0] < windowStart) {
      deque.shift();
    }

    result[i] = values[deque[0]];
  }

  return result;
}

// The literal shared formula: is closes[index] within `ratio` of the
// highest close in the trailing `lookbackBars` window ending at (and
// including) index itself? This single function is what "near its own
// multi-year high" means everywhere in the product - the full two-leg
// evaluator below and the RS pipeline's weekly-only pre-filter are both
// built directly on top of it, so there is exactly one place this
// arithmetic is written.
export function passesNearHigh(
  closes: number[],
  index: number,
  lookbackBars: number,
  ratio: number = WEEKLY_STRONG_NEAR_HIGH_RATIO
): boolean {
  const start = Math.max(0, index - lookbackBars + 1);
  let high = -Infinity;
  for (let i = start; i <= index; i++) {
    if (closes[i] > high) high = closes[i];
  }
  return closes[index] > high * ratio;
}

export type WeeklyStrongDecision = {
  passes: boolean;
  passesDaily: boolean;
  passesWeekly: boolean;
};

// The full two-condition decision at the LATEST available bar of each
// series - replaces computeWeeklyStrongStocks's per-symbol inner logic
// exactly (same "last element of each array" access pattern, no daily/
// weekly date alignment needed since both series are "as of now").
// Caller is responsible for the MIN_WEEKLY_STRONG_*_BARS history check
// (hasSufficientWeeklyStrongHistory) before calling this.
export function evaluateWeeklyStrongLatest(
  dailyCloses: number[],
  weeklyCloses: number[],
  options: {
    dailyLookbackBars?: number;
    weeklyLookbackBars?: number;
    ratio?: number;
  } = {}
): WeeklyStrongDecision {
  const dailyLookbackBars = options.dailyLookbackBars ?? WEEKLY_STRONG_DAILY_LOOKBACK_BARS;
  const weeklyLookbackBars = options.weeklyLookbackBars ?? WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS;
  const ratio = options.ratio ?? WEEKLY_STRONG_NEAR_HIGH_RATIO;

  const passesDaily = passesNearHigh(dailyCloses, dailyCloses.length - 1, dailyLookbackBars, ratio);
  const passesWeekly = passesNearHigh(weeklyCloses, weeklyCloses.length - 1, weeklyLookbackBars, ratio);

  return { passes: passesDaily && passesWeekly, passesDaily, passesWeekly };
}

// Window-size derivation for the Scanner's own caller-chosen lookback (its
// lookback-multiplier UI control) - as opposed to the fixed 250/1252-bar
// Weekly Strong screen elsewhere, which never calls this. Written once so
// the Scanner's live near-high scan and its backtest overlay can't drift
// apart on window SIZE the way they previously drifted on the pass/fail
// RULE itself (see near-250-week-high.ts and computeSymbolBreakoutBacktest -
// both call this now instead of each deriving the 1:5 daily/weekly bar
// ratio independently).
export function deriveScannerLookbackBars(lookbackWeeks: number): {
  dailyLookbackBars: number;
  weeklyLookbackBars: number;
} {
  return {
    weeklyLookbackBars: Math.max(1, Math.round(lookbackWeeks)),
    dailyLookbackBars: Math.max(1, Math.round(lookbackWeeks * 5)),
  };
}

export type WeeklyStrongSeriesPoint = {
  time: string;
  passes: boolean;
  passesDaily: boolean;
  passesWeekly: boolean;
};

// The full two-condition decision at EVERY weekly bar in the series -
// replaces the identical daily/weekly alignment-walk + rollingMax logic
// that used to be duplicated between computeWeeklyStrongStocksBacktest and
// computeSymbolBreakoutBacktest. dailyCandles/weeklyCandles must both be
// chronologically ascending (what readDailyAndWeeklyMetricCandles/
// deriveWeeklyMetricCandlesFromDaily already return everywhere in this
// codebase) - the alignment walk assumes that ordering.
export function evaluateWeeklyStrongSeries(
  dailyCandles: WeeklyStrongCandle[],
  weeklyCandles: WeeklyStrongCandle[],
  options: {
    dailyLookbackBars?: number;
    weeklyLookbackBars?: number;
    ratio?: number;
  } = {}
): WeeklyStrongSeriesPoint[] {
  const dailyLookbackBars = options.dailyLookbackBars ?? WEEKLY_STRONG_DAILY_LOOKBACK_BARS;
  const weeklyLookbackBars = options.weeklyLookbackBars ?? WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS;
  const ratio = options.ratio ?? WEEKLY_STRONG_NEAR_HIGH_RATIO;

  const dailyCloses = dailyCandles.map((row) => row.close);
  const weeklyCloses = weeklyCandles.map((row) => row.close);
  const dailyMaxArr = rollingMax(dailyCloses, dailyLookbackBars);
  const weeklyMaxArr = rollingMax(weeklyCloses, weeklyLookbackBars);

  const points: WeeklyStrongSeriesPoint[] = [];
  let dailyIndex = 0;

  for (let weeklyIndex = 0; weeklyIndex < weeklyCandles.length; weeklyIndex++) {
    const weeklyRow = weeklyCandles[weeklyIndex];

    // Advance the daily pointer to the last daily bar that's still <= this
    // weekly bar's own time - same two-pointer walk both original
    // implementations used, now written once.
    while (
      dailyIndex + 1 < dailyCandles.length &&
      dailyCandles[dailyIndex + 1].time <= weeklyRow.time
    ) {
      dailyIndex++;
    }
    if (dailyCandles[dailyIndex].time > weeklyRow.time) continue;

    const passesWeekly = weeklyCloses[weeklyIndex] > weeklyMaxArr[weeklyIndex] * ratio;
    const passesDaily = dailyCloses[dailyIndex] > dailyMaxArr[dailyIndex] * ratio;

    points.push({
      time: weeklyRow.time,
      passes: passesWeekly && passesDaily,
      passesDaily,
      passesWeekly,
    });
  }

  return points;
}
