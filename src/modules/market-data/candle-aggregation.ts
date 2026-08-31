export type CandleInput = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// Exported for trading-calendar.ts's completed-week helpers - the whole
// point is that "is this week done yet" compares against the exact same
// ISO-week grouping aggregateWeeklyCandles itself uses, not a second,
// possibly-diverging notion of "week".
export function getWeekKey(date: Date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getMonthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function aggregate(candles: CandleInput[], keyForDate: (date: Date) => string) {
  const sorted = [...candles].sort((a, b) => a.time.localeCompare(b.time));
  const groups = new Map<string, CandleInput[]>();

  for (const candle of sorted) {
    const key = keyForDate(new Date(`${candle.time}T00:00:00.000Z`));
    groups.set(key, [...(groups.get(key) ?? []), candle]);
  }

  return Array.from(groups.values()).map((group) => {
    const first = group[0];
    const last = group[group.length - 1];

    return {
      time: first.time,
      open: first.open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: last.close,
      volume: group.reduce((total, candle) => total + candle.volume, 0),
    };
  });
}

export function aggregateWeeklyCandles(candles: CandleInput[]) {
  return aggregate(candles, getWeekKey);
}

export function aggregateMonthlyCandles(candles: CandleInput[]) {
  return aggregate(candles, getMonthKey);
}
