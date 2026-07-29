import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().optional(),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  ENCRYPTION_MASTER_KEY: z.string().min(32),
  ENCRYPTION_KEY_VERSION: z.string().min(1).default("v1"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  DATA_PROVIDER: z.enum(["eodhd", "zerodha", "global-datafeeds"]).default("eodhd"),
  EODHD_API_TOKEN: z.string().optional(),
  EODHD_EXCHANGE_CODE: z.string().trim().min(1).default("US"),
  ZERODHA_API_KEY: z.string().optional(),
  ZERODHA_API_SECRET: z.string().optional(),
  ZERODHA_REDIRECT_URL: z.string().url().optional(),
  GLOBAL_DATAFEEDS_ENABLED: z.coerce.boolean().default(false),
  GLOBAL_DATAFEEDS_API_KEY: z.string().optional(),
  GLOBAL_DATAFEEDS_WS_URL: z.string().url().default("wss://test.lisuns.com:4576"),
  GLOBAL_DATAFEEDS_EXCHANGES: z.string().default("BSE,BSE_IDX"),
  GLOBAL_DATAFEEDS_SYMBOL_LIMIT: z.coerce.number().int().positive().default(100),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_EXTRACTION_MODEL: z.string().trim().min(1).optional(),
  GEMINI_CHAT_MODEL: z.string().trim().min(1).optional(),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
