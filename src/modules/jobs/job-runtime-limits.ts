import { JOB_NAMES } from "../../shared/constants";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const JOB_RUNTIME_LIMITS_MS: Record<string, number> = {
  [JOB_NAMES.chartCandleEnsureFresh]: 15 * MINUTE_MS,
  [JOB_NAMES.instrumentSync]: 45 * MINUTE_MS,
  [JOB_NAMES.priceRefresh]: 45 * MINUTE_MS,
  [JOB_NAMES.sectorClassificationSync]: 15 * MINUTE_MS,
  [JOB_NAMES.candleBootstrapReconcile]: 10 * MINUTE_MS,
  [JOB_NAMES.indexCandleBackfill]: 2 * HOUR_MS,
  [JOB_NAMES.dailyCandleSync]: 8 * HOUR_MS,
  [JOB_NAMES.marketDataCatchUp]: 8 * HOUR_MS,
  [JOB_NAMES.weeklyStrongBacktestBackfill]: 4 * HOUR_MS,
  [JOB_NAMES.weeklyStrongBacktestHistoricalRebuild]: 4 * HOUR_MS,
  [JOB_NAMES.collectionPrepare]: 2 * HOUR_MS,
};

const DEFAULT_JOB_RUNTIME_LIMIT_MS = 2 * HOUR_MS;

export function getJobRuntimeLimitMs(jobName: string) {
  return JOB_RUNTIME_LIMITS_MS[jobName] ?? DEFAULT_JOB_RUNTIME_LIMIT_MS;
}
