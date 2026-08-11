import { z } from "zod";

import { CANDLE_TIMEFRAME, CANDLE_TIMEFRAMES, DEFAULT_CANDLE_TIMEFRAME } from "../../shared/constants";
import { exchangeSchema } from "../market-data/market-data.schemas";
import {
  DEFAULT_SCANNER_LOOKBACK,
  SCANNER_LOOKBACK_MULTIPLIERS,
  type ScannerLookbackMultiplier,
} from "./scanner.constants";

export type { ScannerLookbackMultiplier };

const candleTimeframeSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1d") return CANDLE_TIMEFRAME.day;
  if (normalized === "1w") return CANDLE_TIMEFRAME.week;
  if (normalized === "1m" || normalized === "1mo") return CANDLE_TIMEFRAME.month;
  return value;
}, z.enum(CANDLE_TIMEFRAMES));

export const scannerResultsQuerySchema = z
  .object({
    symbol: z.string().trim().max(64).optional(),
    timeframe: candleTimeframeSchema.default(DEFAULT_CANDLE_TIMEFRAME),
    rule: z.string().trim().max(128).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    exchange: exchangeSchema,
    lookback: z.enum(SCANNER_LOOKBACK_MULTIPLIERS).default(DEFAULT_SCANNER_LOOKBACK),
  })
  .strict();

export const scannerSymbolParamsSchema = z
  .object({
    symbol: z.string().trim().min(1).max(64),
  })
  .strict();

export const scannerBacktestQuerySchema = z
  .object({
    exchange: exchangeSchema,
    lookback: z.enum(SCANNER_LOOKBACK_MULTIPLIERS).default(DEFAULT_SCANNER_LOOKBACK),
  })
  .strict();

