export type ScannerWeeklyCandle = { time: string; close: number };

export type ScannerQualificationPoint = { time: string; passes: boolean };

export const SCANNER_NEAR_HIGH_RATIO = 0.85;

function rollingMax(values: number[], windowSize: number): number[] {
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

export function evaluateScannerWeeklySeries(
  weeklyCandles: ScannerWeeklyCandle[],
  lookbackWeeks: number
): ScannerQualificationPoint[] {
  const closes = weeklyCandles.map((row) => row.close);
  const rollingHighs = rollingMax(closes, lookbackWeeks);

  return weeklyCandles.map((row, index) => ({
    time: row.time,
    passes: index >= lookbackWeeks - 1 && closes[index] > rollingHighs[index] * SCANNER_NEAR_HIGH_RATIO,
  }));
}
