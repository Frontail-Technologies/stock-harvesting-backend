import {
  computeAllRelativeStrengthMetrics,
  computeWeeklyStrongStocks,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
  type WeeklyStrongStockRow,
} from "./market-data.service";
import { WEEKLY_STRONG_EVALUATOR_VERSION } from "./weekly-strong-evaluator";
import {
  deleteDashboardSnapshots,
  readDashboardSnapshot,
  readDashboardSnapshotWithMeta,
  RELATIVE_STRENGTH_SNAPSHOT_VERSION,
  writeDashboardSnapshot,
} from "./dashboard-snapshot-store";

// Returns the full base metrics array for this collection's active-member
// pool. Callers (see getCollectionRelativeStrength in
// market-collections.service.ts) share this one persisted snapshot and
// derive their own view from it in-memory, so the expensive base
// calculation runs once, not once per derived view.
//
// On a miss this computes and persists inline - a bootstrap/exception
// path; every later request for this collection hits the stored row until
// invalidateCollectionSnapshots runs.
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

// Same snapshot pattern for the Weekly Strong passing-stocks list.
export async function getOrComputeWeeklyStrongSnapshot(
  collectionId: string,
  exchange: string,
  memberRows: Parameters<typeof computeWeeklyStrongStocks>[0]
): Promise<WeeklyStrongStockRow[]> {
  const cached = await readDashboardSnapshot<WeeklyStrongStockRow[]>("collection", collectionId, "weekly_strong");
  if (cached) return cached;

  const computed = await computeWeeklyStrongStocks(memberRows, exchange);
  await writeDashboardSnapshot({
    scopeType: "collection",
    scopeKey: collectionId,
    metricType: "weekly_strong",
    exchange,
    evaluatorVersion: WEEKLY_STRONG_EVALUATOR_VERSION,
    payload: computed,
  });
  return computed;
}

// Called when this collection's data actually changes (a confirmed admin
// import), not on a fixed TTL. The next read of either metric type
// recomputes and re-persists on its own.
export async function invalidateCollectionSnapshots(collectionId: string): Promise<void> {
  await deleteDashboardSnapshots("collection", collectionId);
}
