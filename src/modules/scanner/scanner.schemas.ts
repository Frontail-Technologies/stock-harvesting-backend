import { z } from "zod";

import { DEFAULT_CANDLE_TIMEFRAME } from "../../shared/constants";
import { candleTimeframeSchema } from "../../shared/validation/market.schemas";
import { exchangeSchema } from "../market-data/market-data.schemas";
import {
  DEFAULT_SCANNER_LOOKBACK,
  SCANNER_LOOKBACK_MULTIPLIERS,
  type ScannerLookbackMultiplier,
} from "./scanner.constants";

export type { ScannerLookbackMultiplier };

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

