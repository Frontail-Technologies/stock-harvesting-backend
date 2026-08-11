import { z } from "zod";

import { exchangeSchema } from "../market-data/market-data.schemas";

export const listCollectionsQuerySchema = z
  .object({
    exchange: exchangeSchema.optional(),
  })
  .strict();

export const collectionCodeParamsSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
  })
  .strict();

export const collectionMembersQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(50),
    q: z.string().trim().optional(),
    sortBy: z.enum(["symbol", "name"]).default("symbol"),
    sortDirection: z.enum(["asc", "desc"]).default("asc"),
    includeQuotes: z.coerce.boolean().optional(),
  })
  .strict();

export const collectionRelativeStrengthQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(500).default(200),
    groupBy: z.enum(["sector", "industry"]).optional(),
  })
  .strict();

export const collectionWeeklyStrongBacktestQuerySchema = z
  .object({
    weeks: z.coerce.number().int().positive().max(260).default(156),
  })
  .strict();
