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

// Closed, deliberately small allow-list (Phase D) - every market
// collection in this codebase is India/BSE today, and section 3 of the
// Phase D brief is explicit: "Do not invent unsupported countries." Add a
// new entry here only when there is real backend support (instruments,
// exchanges, and a collection) for that country - the Dashboard's country
// selector reads this transitively via /api/market-collections, not a
// hardcoded frontend list.
export const SUPPORTED_COUNTRIES = [{ code: "IN", label: "India" }] as const;
export type SupportedCountryCode = (typeof SUPPORTED_COUNTRIES)[number]["code"];
export const SUPPORTED_COUNTRY_CODES = SUPPORTED_COUNTRIES.map(
  (country) => country.code
) as SupportedCountryCode[];
export const DEFAULT_COUNTRY_CODE: SupportedCountryCode = "IN";

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

// Capabilities actually implemented today (see DataProviderAdapter in
// data-provider.types.ts) - historical/latest candles are on every adapter,
// search/token/exchange-list are optional per-adapter methods, and
// realtime_ws corresponds to a market-stream/providers/* class existing for
// that provider key (a separate mechanism from the DataProviderAdapter
// interface, not a method on it).
export const PROVIDER_CAPABILITIES = [
  "instrument_sync",
  "historical_daily_candles",
  "latest_daily_candles",
  "instrument_search",
  "instrument_token",
  "exchange_list",
  "realtime_ws",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

// Seed data only (display name + starting priority) - enabled always starts
// true for every provider on first seed, since before this feature existed
// every implemented provider was effectively always "on"; seeding anything
// else would silently break production traffic on migration.
export const DATA_PROVIDER_SETTINGS_SEEDS: ReadonlyArray<{
  key: string;
  displayName: string;
  priority: number;
}> = [
  { key: DATA_PROVIDER_KEY.zerodha, displayName: "Zerodha Kite", priority: 1 },
  { key: DATA_PROVIDER_KEY.globalDatafeeds, displayName: "Global DataFeeds", priority: 1 },
  { key: DATA_PROVIDER_KEY.eodhd, displayName: "EODHD", priority: 100 },
];

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

export const MONETIZATION_MODES = ["off", "preview", "live"] as const;
export type MonetizationMode = (typeof MONETIZATION_MODES)[number];

export const MONETIZATION_MODE = {
  off: "off",
  preview: "preview",
  live: "live",
} as const satisfies Record<MonetizationMode, MonetizationMode>;

export const MONETIZATION_SETTINGS_DEFAULTS = {
  id: 1,
  provider: "adsense",
  mode: MONETIZATION_MODE.off as MonetizationMode,
} as const;

// Stable internal identifiers, never display labels - these are the only
// placements the product actually renders today. "insights_article" has no
// real ad location yet; it's seeded disabled so admin can pre-configure it
// ahead of that page existing.
export const AD_PLACEMENTS = [
  {
    key: "landing_primary",
    label: "Landing — Primary",
    description: "After Chart Workspace",
  },
  {
    key: "landing_secondary",
    label: "Landing — Secondary",
    description: "After Market Coverage",
  },
  {
    key: "scanner_bottom",
    label: "Scanner — Bottom",
    description: "Below chart workspace",
  },
  {
    key: "insights_article",
    label: "Insights — Article",
    description: "Future placement, disabled by default",
  },
] as const;
export type AdPlacementKey = (typeof AD_PLACEMENTS)[number]["key"];
export const AD_PLACEMENT_KEYS = AD_PLACEMENTS.map((p) => p.key) as AdPlacementKey[];
