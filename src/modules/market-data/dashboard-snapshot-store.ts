import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { dashboardMetricSnapshots } from "../../db/schema";
import { getLatestExpectedTradingDay } from "./trading-calendar";

export type DashboardSnapshotScopeType = "collection" | "index_exchange";
export type DashboardSnapshotMetricType = "relative_strength" | "weekly_strong";

// Not a hash of the proprietary formula - just an identifier so a future
// intentional change to the RS calculation can tell old and new snapshots
// apart (mirrors weekly-strong-evaluator.ts's WEEKLY_STRONG_EVALUATOR_VERSION
// for the other metric type). Lives in this dependency-free module (rather
// than dashboard-snapshots.service.ts, which needs market-data.service.ts)
// so market-data.service.ts's own getIndexRelativeStrength can use the
// exact same version tag without creating an import cycle.
// v2: 55-day-change-only ranking (Dashboard top-widget metric change) -
// dropped the near-250-week-high pre-filter and the weekly MACD/monthly
// terms, so a v1 snapshot's row set and values are no longer valid under
// the current formula and must be treated as a miss (see
// readDashboardSnapshotWithMeta's version-aware callers).
export const RELATIVE_STRENGTH_SNAPSHOT_VERSION = "relative-strength-v2";

// Deliberately zero dependency on market-data.service.ts (or anything that
// imports it) - this is pure schema-level read/write/delete, kept as its
// own tiny module specifically so BOTH market-data.service.ts (for the
// "index_exchange" scope, used by getIndexRelativeStrength) and
// dashboard-snapshots.service.ts (for the "collection" scope, which DOES
// need market-data.service.ts's compute functions) can depend on it
// one-directionally without a cycle.

export async function readDashboardSnapshot<T extends unknown[]>(
  scopeType: DashboardSnapshotScopeType,
  scopeKey: string,
  metricType: DashboardSnapshotMetricType
): Promise<T | null> {
  const [row] = await db
    .select({ payload: dashboardMetricSnapshots.payload })
    .from(dashboardMetricSnapshots)
    .where(
      and(
        eq(dashboardMetricSnapshots.scopeType, scopeType),
        eq(dashboardMetricSnapshots.scopeKey, scopeKey),
        eq(dashboardMetricSnapshots.metricType, metricType)
      )
    )
    .limit(1);

  return row ? (row.payload as T) : null;
}

export type DashboardSnapshotRecord<T> = {
  payload: T;
  asOfDate: string;
  evaluatorVersion: string;
};

// Superset of readDashboardSnapshot above - also surfaces asOfDate (the
// real trading-day the payload was computed as of) and evaluatorVersion,
// so a caller can (a) treat a stale-formula row as a miss instead of
// serving it, and (b) display the genuine as-of date instead of "now".
// Kept as a separate function rather than changing readDashboardSnapshot's
// return shape, so the existing weekly_strong callers (which don't need
// either field and are explicitly out of scope for this change) keep
// their exact current behavior untouched.
export async function readDashboardSnapshotWithMeta<T extends unknown[]>(
  scopeType: DashboardSnapshotScopeType,
  scopeKey: string,
  metricType: DashboardSnapshotMetricType
): Promise<DashboardSnapshotRecord<T> | null> {
  const [row] = await db
    .select({
      payload: dashboardMetricSnapshots.payload,
      asOfDate: dashboardMetricSnapshots.asOfDate,
      evaluatorVersion: dashboardMetricSnapshots.evaluatorVersion,
    })
    .from(dashboardMetricSnapshots)
    .where(
      and(
        eq(dashboardMetricSnapshots.scopeType, scopeType),
        eq(dashboardMetricSnapshots.scopeKey, scopeKey),
        eq(dashboardMetricSnapshots.metricType, metricType)
      )
    )
    .limit(1);

  return row
    ? { payload: row.payload as T, asOfDate: row.asOfDate, evaluatorVersion: row.evaluatorVersion }
    : null;
}

export async function writeDashboardSnapshot(input: {
  scopeType: DashboardSnapshotScopeType;
  scopeKey: string;
  metricType: DashboardSnapshotMetricType;
  exchange: string;
  evaluatorVersion: string;
  payload: unknown[];
}): Promise<{ asOfDate: string }> {
  const asOfDate = getLatestExpectedTradingDay(input.exchange);

  await db
    .insert(dashboardMetricSnapshots)
    .values({
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      metricType: input.metricType,
      exchange: input.exchange,
      asOfDate,
      evaluatorVersion: input.evaluatorVersion,
      payload: input.payload,
    })
    .onConflictDoUpdate({
      target: [
        dashboardMetricSnapshots.scopeType,
        dashboardMetricSnapshots.scopeKey,
        dashboardMetricSnapshots.metricType,
      ],
      set: {
        exchange: input.exchange,
        asOfDate,
        evaluatorVersion: input.evaluatorVersion,
        payload: input.payload,
        generatedAt: new Date(),
      },
    });

  return { asOfDate };
}

// Deletes every metric snapshot for one scope (e.g. both
// relative_strength and weekly_strong for one collection) - the
// invalidation half of "recompute when underlying data actually changed,
// not on a fixed TTL". Deleting rather than marking stale
// is deliberate: the next read simply finds nothing, computes fresh, and
// re-persists - one code path handles both "never generated yet" and
// "just invalidated", instead of two.
export async function deleteDashboardSnapshots(
  scopeType: DashboardSnapshotScopeType,
  scopeKey: string
): Promise<void> {
  await db
    .delete(dashboardMetricSnapshots)
    .where(and(eq(dashboardMetricSnapshots.scopeType, scopeType), eq(dashboardMetricSnapshots.scopeKey, scopeKey)));
}
