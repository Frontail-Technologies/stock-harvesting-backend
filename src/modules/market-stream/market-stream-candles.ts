import { CANDLE_TIMEFRAME } from "../../shared/constants";
import type { MarketStreamSymbol } from "./market-stream.types";

type CandleState = MarketStreamSymbol & {
  timeframe: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

const candles = new Map<string, CandleState>();

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function weekKey(date: Date) {
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  return dateKey(monday);
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function candleTime(timeframe: string, date: Date) {
  if (timeframe === CANDLE_TIMEFRAME.day) return dateKey(date);
  if (timeframe === CANDLE_TIMEFRAME.week) return weekKey(date);
  return monthKey(date);
}

function stateKey(input: MarketStreamSymbol & { timeframe: string; time: string }) {
  return `${input.exchange}:${input.symbol}:${input.timeframe}:${input.time}`;
}

export function applyTickToCandles(input: MarketStreamSymbol & {
  price: number;
  volume?: number;
  time: string;
}) {
  const date = new Date(input.time);
  if (Number.isNaN(date.getTime())) return [];

  return Object.values(CANDLE_TIMEFRAME).map((timeframe) => {
    const time = candleTime(timeframe, date);
    const key = stateKey({ ...input, timeframe, time });
    const existing = candles.get(key);
    const volume = input.volume ?? existing?.volume;
    const next: CandleState = existing
      ? {
          ...existing,
          high: Math.max(existing.high, input.price),
          low: Math.min(existing.low, input.price),
          close: input.price,
          volume,
        }
      : {
          exchange: input.exchange,
          symbol: input.symbol,
          timeframe,
          time,
          open: input.price,
          high: input.price,
          low: input.price,
          close: input.price,
          volume,
        };

    candles.set(key, next);
    return {
      type: "market.candle.update" as const,
      data: next,
    };
  });
}
