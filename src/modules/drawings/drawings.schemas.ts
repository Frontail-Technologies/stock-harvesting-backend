import { z } from "zod";

import { CANDLE_TIMEFRAMES } from "../../shared/constants";
import { exchangeSchema } from "../market-data/market-data.schemas";

export const workspaceParamsSchema = z
  .object({
    symbol: z.string().trim().min(1).max(64),
    timeframe: z.enum(CANDLE_TIMEFRAMES),
  })
  .strict();

export const workspaceQuerySchema = z
  .object({
    exchange: exchangeSchema,
  })
  .strict();

export const drawingIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const drawingPayloadSchema = z
  .object({
    id: z.string().uuid().optional(),
    drawingType: z.string().trim().min(1).max(64),
    payload: z.record(z.string(), z.unknown()),
    locked: z.boolean().default(false),
    hidden: z.boolean().default(false),
  })
  .strict();

export const replaceDrawingsBodySchema = z
  .object({
    drawings: z.array(drawingPayloadSchema).max(500),
  })
  .strict();

export const patchDrawingBodySchema = drawingPayloadSchema.partial().strict();
