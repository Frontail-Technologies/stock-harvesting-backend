import { z } from "zod";

// Deliberately NOT the shared exchangeSchema here: that schema carries its
// own `.default(DEFAULT_EXCHANGE)` ("US") baked in for endpoints where "no
// exchange specified" should mean "assume the default market" - wrapping
// it in `.optional()` does NOT suppress that inner default for a genuinely
// absent key (confirmed empirically: `exchangeSchema.optional().parse({})`
// still yields "US", not undefined - a real zod-composition gotcha, not a
// misunderstanding). For THIS endpoint specifically, "no exchange" must
// mean "don't filter by exchange" (the Dashboard's own country-derivation
// flow calls it with no filters at all to see every collection across
// every country) - a silent "US" filter here made every one of
// this app's real BSE-only collections invisible.
export const listCollectionsQuerySchema = z
  .object({
    exchange: z.string().trim().min(1).max(16).transform((value) => value.toUpperCase()).optional(),
    countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).optional(),
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
