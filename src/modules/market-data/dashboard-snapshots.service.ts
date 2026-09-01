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

// THE fix for "the expensive base calculation should happen once, not
// once per derived view". Returns the FULL base metrics array for this
// collection's active-member pool - Sector/Industry cards (and, before
// this fix, an entirely unused third `rsQuery` call) all used to
// independently re-run computeAllRelativeStrengthMetrics from scratch.
// Callers now share this one persisted snapshot and derive their own view
// from it in-memory (pickTopRelativeStrengthRows /
// groupRelativeStrengthMetrics - pure, no candle I/O) - see
// getCollectionRelativeStrength in market-collections.service.ts.
//
// On a snapshot miss (never generated yet, or just invalidated - see
// invalidateCollectionSnapshots below) this computes synchronously inline
// and persists the result before returning - an exception/bootstrap path,
// not what a normal request depends on: every request after this one, for
// this collection, hits the stored row directly until something actually
// invalidates it again.
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

// Same pattern for the Weekly Strong passing-stocks list (the table and
// its matching Dashboard card) - computeWeeklyStrongStocks itself is
// completely unchanged - this only changes how often it actually runs,
// never the formula itself.
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

// Invalidation - called when this collection's underlying
// data actually changes (a confirmed admin import - see
// importCollectionCsv) rather than relied on as a fixed TTL. Deletes both
// metric types for this collection; the next read of either recomputes
// and re-persists on its own (see the getOrCompute functions above).
export async function invalidateCollectionSnapshots(collectionId: string): Promise<void> {
  await deleteDashboardSnapshots("collection", collectionId);
}
