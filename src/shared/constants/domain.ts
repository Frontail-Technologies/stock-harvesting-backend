export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE = {
  user: "user",
  admin: "admin",
} as const satisfies Record<UserRole, UserRole>;

export const USER_PLANS = ["free", "pro"] as const;
export type UserPlan = (typeof USER_PLANS)[number];

export const USER_PLAN = {
  free: "free",
  pro: "pro",
} as const satisfies Record<UserPlan, UserPlan>;

export const DEFAULT_USER_ROLE = USER_ROLE.user;
export const DEFAULT_USER_PLAN = USER_PLAN.free;

export const PLAN_USAGE_LIMITS: Record<
  UserPlan,
  {
    dailyScanLimit: number;
    apiAccessEnabled: boolean;
  }
> = {
  free: {
    dailyScanLimit: 50,
    apiAccessEnabled: false,
  },
  pro: {
    dailyScanLimit: 200,
    apiAccessEnabled: true,
  },
};

export const DEFAULT_EXCHANGE = "US" as const;

export const SUPPORTED_EXCHANGES = [
  { code: "US", label: "United States" },
  { code: "NSE", label: "India (NSE)" },
  { code: "BSE", label: "India (BSE)" },
  { code: "BSE_IDX", label: "India (BSE Indices)" },
] as const;
export type SupportedExchangeCode = (typeof SUPPORTED_EXCHANGES)[number]["code"];
export const SUPPORTED_EXCHANGE_CODES = SUPPORTED_EXCHANGES.map(
  (exchange) => exchange.code
) as SupportedExchangeCode[];

export const CANDLE_TIMEFRAMES = ["1D", "1W", "1M"] as const;
export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];
export const CANDLE_TIMEFRAME = {
  day: "1D",
  week: "1W",
  month: "1M",
} as const satisfies Record<string, CandleTimeframe>;
export const DEFAULT_CANDLE_TIMEFRAME = CANDLE_TIMEFRAME.week;

export const PROVIDER_STATUSES = [
  "disconnected",
  "connected",
  "expired",
  "error",
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_STATUS = {
  disconnected: "disconnected",
  connected: "connected",
  expired: "expired",
  error: "error",
} as const satisfies Record<ProviderStatus, ProviderStatus>;

export const JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
} as const satisfies Record<JobStatus, JobStatus>;

export const SCAN_RUN_STATUSES = JOB_STATUSES;

export const CANDLE_SOURCE = {
  provider: "provider",
  derived: "derived",
} as const;

export const AUTH_PROVIDER = {
  google: "google",
} as const;

export const DATA_PROVIDER_KEY = {
  eodhd: "eodhd",
  zerodha: "zerodha",
  globalDatafeeds: "global-datafeeds",
} as const;

export const BRANDING_DEFAULTS = {
  id: 1,
  brandName: "Stock Harvesting",
  watermarkText: "Stock Harvesting",
} as const;

export const SUPPORTED_AI_MODELS = [
  { code: "gemini-flash-latest", label: "Gemini Flash Latest" },
  { code: "gemini-flash-lite-latest", label: "Gemini Flash Lite Latest" },
  { code: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { code: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { code: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
  { code: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { code: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { code: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
] as const;
export type SupportedAiModelCode = (typeof SUPPORTED_AI_MODELS)[number]["code"];
export const SUPPORTED_AI_MODEL_CODES = SUPPORTED_AI_MODELS.map(
  (model) => model.code
) as SupportedAiModelCode[];

export const AI_SETTINGS_DEFAULTS = {
  id: 1,
  model: "gemini-flash-latest" as SupportedAiModelCode,
} as const;
