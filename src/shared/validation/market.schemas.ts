import { z } from "zod";

import { CANDLE_TIMEFRAME, CANDLE_TIMEFRAMES } from "../constants";

export const candleTimeframeSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1d") return CANDLE_TIMEFRAME.day;
  if (normalized === "1w") return CANDLE_TIMEFRAME.week;
  if (normalized === "1m" || normalized === "1mo") return CANDLE_TIMEFRAME.month;
  return value;
}, z.enum(CANDLE_TIMEFRAMES));

export type CandleTimeframeSchema = z.infer<typeof candleTimeframeSchema>;
