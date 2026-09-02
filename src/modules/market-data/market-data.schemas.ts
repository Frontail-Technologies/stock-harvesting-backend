import { z } from "zod";

import { CANDLE_TIMEFRAME, CANDLE_TIMEFRAMES, DEFAULT_CANDLE_TIMEFRAME, DEFAULT_EXCHANGE } from "../../shared/constants";
import { GLOBAL_DATAFEEDS_INDEX_EXCHANGE } from "../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import { NSE_INDEX_EXCHANGE } from "../data-provider/adapters/zerodha-data-provider.adapter";

// Open rather than a closed enum - the exchange list is dynamic (see
// listSupportedExchanges), sourced live from EODHD (~70 exchanges) plus
// NSE. Bad codes fail gracefully downstream (the data-provider adapter
// returns empty results for an unknown exchange code) rather than needing
// this schema to know the full valid set up front.
export const exchangeSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((value) => value.toUpperCase())
  .default(DEFAULT_EXCHANGE);

export const MOVE_FILTERS = ["all", "gainers", "decliners", "unchanged"] as const;
export type MoveFilter = (typeof MOVE_FILTERS)[number];

const candleTimeframeSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1d") return CANDLE_TIMEFRAME.day;
  if (normalized === "1w") return CANDLE_TIMEFRAME.week;
  if (normalized === "1m" || normalized === "1mo") return CANDLE_TIMEFRAME.month;
  return value;
}, z.enum(CANDLE_TIMEFRAMES));

export const stockListQuerySchema = z
  .object({
    q: z.string().trim().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(2000).default(25),
    sortBy: z.enum(["symbol", "name", "close", "changePct", "volume"]).default("name"),
    sortDirection: z.enum(["asc", "desc"]).default("asc"),
    exchange: exchangeSchema,
    moveFilter: z.enum(MOVE_FILTERS).default("all"),
    minVolume: z.coerce.number().nonnegative().optional(),
    includeUnpriced: z.coerce.boolean().default(false),
  })
  .strict();

export const chartEligibleStockSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1),
    limit: z.coerce.number().int().positive().max(20).default(8),
    exchange: z.literal("BSE").default("BSE"),
  })
  .strict();

export const candleParamsSchema = z
  .object({
    symbol: z.string().trim().min(1).max(64),
  })
  .strict();

export const candleQuerySchema = z
  .object({
    timeframe: candleTimeframeSchema.default(DEFAULT_CANDLE_TIMEFRAME),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    exchange: exchangeSchema,
  })
  .strict();

// No timeframe/from/to here on purpose - the public candles route always
// returns full daily history only (see market-data.routes.ts), so there is
// nothing for an anonymous caller to override.
export const publicCandleQuerySchema = z
  .object({
    exchange: exchangeSchema,
  })
  .strict();

export const historyRangeQuerySchema = z
  .object({
    symbol: z.string().trim().min(1).max(64),
    timeframe: candleTimeframeSchema.default(DEFAULT_CANDLE_TIMEFRAME),
    exchange: exchangeSchema,
  })
  .strict();

// Closed whitelist, unlike the general exchangeSchema above - there are
// only ever a handful of *index* exchanges, and an unrecognized one would
// silently return an empty ranking rather than erroring, so it's worth
// rejecting up front instead.
export const indexRelativeStrengthQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(500).default(150),
    exchange: z.enum([NSE_INDEX_EXCHANGE, GLOBAL_DATAFEEDS_INDEX_EXCHANGE]).default(NSE_INDEX_EXCHANGE),
  })
  .strict();


