export const QUEUE_NAMES = {
  marketData: "market-data",
} as const;

export const JOB_NAMES = {
  instrumentSync: "instrument-sync",
  priceRefresh: "price-refresh",
  weeklyStrongBacktestBackfill: "weekly-strong-backtest-backfill",
  weeklyStrongBacktestHistoricalRebuild: "weekly-strong-backtest-historical-rebuild",
} as const;

export const SYNC_JOB_TYPES = {
  instrumentSync: "market-data.instrument-sync",
  priceRefresh: "market-data.price-refresh",
  sectorClassificationSync: "market-data.sector-classification-sync",
  indexCandleBackfill: "market-data.index-candle-backfill",
  weeklyStrongBacktestBackfill: "market-data.weekly-strong-backtest-backfill",
  weeklyStrongBacktestHistoricalRebuild: "market-data.weekly-strong-backtest-historical-rebuild",
} as const;
