// The canonical "Weekly Strong" / near-multi-year-high breakout evaluator - the single source of truth for this decision; every caller (live list, backtest, Scanner overlay) goes through the functions below rather than reimplementing the check. computeSymbolBreakoutBacktest uses caller-chosen window sizes instead of the fixed defaults; computeAllRelativeStrengthMetrics uses only the weekly half (via passesNearHigh) as an unrelated pre-filter, not the full two-condition screen.

import { isCompletedTradingWeek } from "./trading-calendar";

export type WeeklyStrongCandle = { time: string; close: number };

// Bumped only when the evaluator's actual decision logic changes - persisted alongside every weekly_strong_backtest_runs row so a future intentional change can tell which history was generated under which version; a label, not a hash of the formula/thresholds.
export const WEEKLY_STRONG_EVALUATOR_VERSION = "weekly-strong-v1";

// Proprietary constants - unchanged values, just one definition instead of duplicated literals; not re-exported through any public API response.
export const WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS = 250;
export const WEEKLY_STRONG_DAILY_LOOKBACK_BARS = 1252;
export const WEEKLY_STRONG_NEAR_HIGH_RATIO = 0.85;
// Floor below the full lookback windows - enough of a sample that a symbol's trailing close isn't trivially just its own recent close; deliberately separate from computeAllRelativeStrengthMetrics's own minimum, which guards unrelated metrics, not this condition.
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

// Drops a trailing in-progress week so it's never evaluated as finished, live or historical. At most one incomplete trailing week can exist (weeks fill in chronological order), so only the last entry needs checking - see trading-calendar.ts's isCompletedTradingWeek. Scoped to the Weekly Strong pipeline only; the separate Relative Strength cards' weekly pre-filter does not call this.
export function excludeIncompleteTradingWeek<T extends { time: string }>(
  weeklyRows: T[],
  exchange: string,
  at: Date = new Date()
): T[] {
  if (weeklyRows.length === 0) return weeklyRows;
  const last = weeklyRows[weeklyRows.length - 1];
  return isCompletedTradingWeek(last.time, exchange, at) ? weeklyRows : weeklyRows.slice(0, -1);
}

// Sliding-window maximum: result[i] = max(values[i - windowSize + 1 .. i]), inclusive of i; O(n) total via a monotonic deque, so the series evaluators below avoid an O(n*windowSize) scan.
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

// The single definition of "near its own multi-year high" - both the full two-leg evaluator below and the RS pipeline's weekly-only pre-filter are built on this one function.
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

// The full two-condition decision at the latest bar of each series; caller must check hasSufficientWeeklyStrongHistory before calling this.
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

// Window-size derivation for the Scanner's caller-chosen lookback (its lookback-multiplier control), separate from the fixed-window Weekly Strong screen; both the live scan and computeSymbolBreakoutBacktest call this so they can't drift apart on window size.
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

// The full two-condition decision at every weekly bar in the series; dailyCandles/weeklyCandles must both be chronologically ascending - the alignment walk below assumes that ordering.
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

    // Advance to the last daily bar still <= this weekly bar's time.
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

// Where the CURRENT (trailing) unbroken run of passing weeks began - the same "entry" concept computeSymbolBreakoutBacktest uses to open a trade, here for a still-open qualifying streak. Returns null if the series is empty or doesn't currently end in a passing state (defensive even though callers only ask this for a symbol known to pass now); never invents a reference point, just walks the pass/fail series evaluateWeeklyStrongSeries already produces.
export function findCurrentStreakEntryIndex(series: WeeklyStrongSeriesPoint[]): number | null {
  if (series.length === 0 || !series[series.length - 1].passes) return null;

  let index = series.length - 1;
  while (index > 0 && series[index - 1].passes) index--;
  return index;
}
