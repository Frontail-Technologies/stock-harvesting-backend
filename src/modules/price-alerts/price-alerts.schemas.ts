import { z } from "zod";

import { exchangeSchema } from "../market-data/market-data.schemas";

export const priceAlertConditionSchema = z.enum(["ABOVE", "BELOW"]);
export const priceAlertStatusSchema = z.enum(["ACTIVE", "TRIGGERED", "DISABLED"]);

export const listPriceAlertsQuerySchema = z
  .object({
    exchange: exchangeSchema.optional(),
    symbol: z.string().trim().min(1).max(64).optional(),
    status: priceAlertStatusSchema.optional(),
  })
  .strict();

export const createPriceAlertBodySchema = z
  .object({
    exchange: exchangeSchema,
    symbol: z.string().trim().min(1).max(64),
    condition: priceAlertConditionSchema,
    targetPrice: z.coerce.number().positive(),
    currentPrice: z.coerce.number().positive().optional(),
  })
  .strict();

export const priceAlertIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const updatePriceAlertBodySchema = z
  .object({
    status: priceAlertStatusSchema.optional(),
    targetPrice: z.coerce.number().positive().optional(),
  })
  .strict();
