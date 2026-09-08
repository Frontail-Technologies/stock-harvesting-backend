import {
  computeAllRelativeStrengthMetrics,
  computeWeeklyStrongStocks,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
  type WeeklyStrongStockRow,
} from "./market-data.service";
import {
  deleteDashboardSnapshots,
  readDashboardSnapshotWithMeta,
  RELATIVE_STRENGTH_SNAPSHOT_VERSION,
  WEEKLY_STRONG_SNAPSHOT_VERSION,
  writeDashboardSnapshot,
} from "./dashboard-snapshot-store";
import { resolveCompletedWeekEndingFromTradingDay } from "./trading-calendar";

// Returns the full base metrics array for this collection's active-member pool; callers share this one persisted snapshot and derive their own view in-memory, so the expensive base calculation runs once. On a miss this computes and persists inline (bootstrap path); later requests hit the stored row until invalidateCollectionSnapshots runs.
export async function getOrComputeCollectionRelativeStrengthBase(
  collectionId: string,
  exchange: string,
  memberRows: RelativeStrengthInstrumentInput[]
): Promise<{ metrics: RelativeStrengthMetricRow[]; asOfDate: string }> {
  const cached = await readDashboardSnapshotWithMeta<RelativeStrengthMetricRow[]>(
    "collection",
    collectionId,
    "relative_strength"
  );
  if (cached && cached.evaluatorVersion === RELATIVE_STRENGTH_SNAPSHOT_VERSION) {
    return { metrics: cached.payload, asOfDate: cached.asOfDate };
  }

  const computed = await computeAllRelativeStrengthMetrics(memberRows, exchange);
  const { asOfDate } = await writeDashboardSnapshot({
    scopeType: "collection",
    scopeKey: collectionId,
    metricType: "relative_strength",
    exchange,
    evaluatorVersion: RELATIVE_STRENGTH_SNAPSHOT_VERSION,
    payload: computed,
  });
  return { metrics: computed, asOfDate };
}

// Same snapshot pattern for the Weekly Strong list, version-checked like relative_strength above, so a row cached under an older shape (e.g. pre-returnPct) is treated as a miss and recomputed rather than served stale.
export async function getOrComputeWeeklyStrongSnapshot(
  collectionId: string,
  exchange: string,
  memberRows: Parameters<typeof computeWeeklyStrongStocks>[0]
): Promise<{ items: WeeklyStrongStockRow[]; weekEnding: string }> {
  const cached = await readDashboardSnapshotWithMeta<WeeklyStrongStockRow[]>(
    "collection",
    collectionId,
    "weekly_strong"
  );
  if (cached && cached.evaluatorVersion === WEEKLY_STRONG_SNAPSHOT_VERSION) {
    return { items: cached.payload, weekEnding: resolveCompletedWeekEndingFromTradingDay(cached.asOfDate) };
  }

  const computed = await computeWeeklyStrongStocks(memberRows, exchange);
  const { asOfDate } = await writeDashboardSnapshot({
    scopeType: "collection",
    scopeKey: collectionId,
    metricType: "weekly_strong",
    exchange,
    evaluatorVersion: WEEKLY_STRONG_SNAPSHOT_VERSION,
    payload: computed,
  });
  return { items: computed, weekEnding: resolveCompletedWeekEndingFromTradingDay(asOfDate) };
}

// Called when this collection's data actually changes (a confirmed admin import), not on a fixed TTL; the next read of either metric type recomputes and re-persists on its own.
export async function invalidateCollectionSnapshots(collectionId: string): Promise<void> {
  await deleteDashboardSnapshots("collection", collectionId);
}
