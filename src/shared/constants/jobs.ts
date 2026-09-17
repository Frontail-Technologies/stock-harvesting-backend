export const QUEUE_NAMES = {
  marketData: "market-data",
} as const;

export const JOB_NAMES = {
  instrumentSync: "instrument-sync",
  priceRefresh: "price-refresh",
  dailyCandleSync: "daily-candle-sync",
  chartCandleEnsureFresh: "chart-candle-ensure-fresh",
  candleBootstrapReconcile: "candle-bootstrap-reconcile",
  weeklyStrongBacktestBackfill: "weekly-strong-backtest-backfill",
  weeklyStrongBacktestHistoricalRebuild: "weekly-strong-backtest-historical-rebuild",
  collectionPrepare: "collection-prepare",
} as const;

export const BACKGROUND_JOB_TYPES = {
  dailyCandleMorning: "daily_candle_morning",
  dailyCandlePostMarket: "daily_candle_post_market",
  dailyCandleRetry: "daily_candle_retry",
  chartEnsureFresh: "chart_ensure_fresh",
} as const;

export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[keyof typeof BACKGROUND_JOB_TYPES];

export const SCHEDULED_DAILY_CANDLE_SYNC_JOB_TYPES: BackgroundJobType[] = [
  BACKGROUND_JOB_TYPES.dailyCandleMorning,
  BACKGROUND_JOB_TYPES.dailyCandlePostMarket,
  BACKGROUND_JOB_TYPES.dailyCandleRetry,
];

export const SYNC_JOB_TYPES = {
  instrumentSync: "market-data.instrument-sync",
  priceRefresh: "market-data.price-refresh",
  sectorClassificationSync: "market-data.sector-classification-sync",
  indexCandleBackfill: "market-data.index-candle-backfill",
  weeklyStrongBacktestBackfill: "market-data.weekly-strong-backtest-backfill",
  weeklyStrongBacktestHistoricalRebuild: "market-data.weekly-strong-backtest-historical-rebuild",
} as const;
