import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),
  ADMIN_WEB_APP_URL: z.string().url().optional(),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  REDIS_URL: z.string().url().optional(),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  USER_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  USER_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  ADMIN_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60),
  ADMIN_REFRESH_TOKEN_TTL_HOURS: z.coerce.number().positive().default(4),
  ENCRYPTION_MASTER_KEY: z.string().min(32),
  ENCRYPTION_KEY_VERSION: z.string().min(1).default("v1"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  AUTH_OTP_EMAIL_WEBHOOK_URL: z.string().url().optional(),
  AUTH_OTP_EMAIL_WEBHOOK_TOKEN: z.string().optional(),
  DATA_PROVIDER: z
    .enum(["eodhd", "zerodha", "global-datafeeds"])
    .default("eodhd"),
  EODHD_API_TOKEN: z.string().optional(),
  EODHD_EXPIRES_AT: z.string().optional(),
  EODHD_EXCHANGE_CODE: z.string().trim().min(1).default("US"),
  ZERODHA_API_KEY: z.string().optional(),
  ZERODHA_API_SECRET: z.string().optional(),
  ZERODHA_REDIRECT_URL: z.string().url().optional(),
  GLOBAL_DATAFEEDS_ENABLED: z.coerce.boolean().default(false),
  GLOBAL_DATAFEEDS_API_KEY: z.string().optional(),
  GLOBAL_DATAFEEDS_EXPIRES_AT: z.string().optional(),
  GLOBAL_DATAFEEDS_WS_URL: z
    .string()
    .url()
    .default("wss://test.lisuns.com:4576"),
  GLOBAL_DATAFEEDS_EXCHANGES: z.string().default("BSE,BSE_IDX"),
  GLOBAL_DATAFEEDS_SYMBOL_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  GLOBAL_DATAFEEDS_FUNDAMENTALS_ENABLED: z.coerce.boolean().default(false),
  GLOBAL_DATAFEEDS_FUNDAMENTALS_ACCESS_KEY: z.string().optional(),
  GLOBAL_DATAFEEDS_FUNDAMENTALS_BASE_URL: z
    .string()
    .url()
    .default("https://test.lisuns.com:4532"),
  GLOBAL_DATAFEEDS_FUNDAMENTALS_EXCHANGE: z.string().default("BSE"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_EXTRACTION_MODEL: z.string().trim().min(1).optional(),
  GEMINI_CHAT_MODEL: z.string().trim().min(1).optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:support@stockharvesting.com"),
  METRICS_ENABLED: z.coerce.boolean().default(false),
  METRICS_TOKEN: z.string().optional(),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().optional(),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
