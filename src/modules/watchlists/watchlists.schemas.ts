import { z } from "zod";

import { exchangeSchema } from "../market-data/market-data.schemas";

export const createWatchlistBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
  })
  .strict();

export const updateWatchlistBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
  })
  .strict();

export const watchlistIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const watchlistItemParamsSchema = z
  .object({
    id: z.string().uuid(),
    itemId: z.string().uuid(),
  })
  .strict();

export const addWatchlistItemBodySchema = z
  .object({
    exchange: exchangeSchema,
    symbol: z.string().trim().min(1).max(64),
  })
  .strict();

export const watchlistRelativeStrengthQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(500).default(200),
  })
  .strict();
