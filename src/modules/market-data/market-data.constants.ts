// Freshness/retry/cache policy values for this module - see
// docs/MARKET_DATA.md's "1D freshness path" section for the reasoning
// behind each one. Kept separate from the orchestration functions that
// read them (market-data.service.ts, market-data.candle-sync.ts).

export const MAX_EXPECTED_TRADING_GAP_DAYS = 21;
export const HISTORY_GAP_BACKFILL_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const COMPLETED_CHART_BACKFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
export const SUPPORTED_EXCHANGES_CACHE_TTL_MS = 24 * 60 * 60_000;
