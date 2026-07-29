import { z } from "zod";

import { CANDLE_TIMEFRAMES, DEFAULT_CANDLE_TIMEFRAME } from "../../shared/constants";
import { exchangeSchema } from "../market-data/market-data.schemas";

export const askScannerQuestionParamsSchema = z
  .object({
    symbol: z.string().trim().min(1).max(64),
  })
  .strict();

export const askScannerQuestionBodySchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    timeframe: z.enum(CANDLE_TIMEFRAMES).default(DEFAULT_CANDLE_TIMEFRAME),
    exchange: exchangeSchema,
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string().trim().min(1).max(2000),
        })
      )
      .max(20)
      .default([]),
  })
  .strict();
