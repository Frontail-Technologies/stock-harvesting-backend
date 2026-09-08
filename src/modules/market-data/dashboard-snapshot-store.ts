import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { dashboardMetricSnapshots } from "../../db/schema";
import { getLatestExpectedTradingDay } from "./trading-calendar";

export type DashboardSnapshotScopeType = "collection" | "index_exchange";
export type DashboardSnapshotMetricType = "relative_strength" | "weekly_strong";

// Version tag (not a formula hash) so old/new RS snapshots can be told apart, mirroring weekly-strong-evaluator.ts's own version constant; lives in this dependency-free module so market-data.service.ts can reuse it without an import cycle. v2 switched to 55-day-change-only ranking (dropped the near-250-week-high pre-filter and weekly MACD/monthly terms), so a v1 snapshot's row set/values are invalid under the current formula and must be treated as a miss - see readDashboardSnapshotWithMeta's version-aware callers.
export const RELATIVE_STRENGTH_SNAPSHOT_VERSION = "relative-strength-v2";

// Same idea for the Weekly Strong snapshot, but its OWN version tag, separate from WEEKLY_STRONG_EVALUATOR_VERSION which tags the pass/fail decision logic itself and is persisted on immutable Backtest history - bumping this one only forces a Dashboard cache refresh. v2 added returnPct; a v1 row is missing the field entirely (not the same as returnPct: null), so it must be treated as a cache miss.
export const WEEKLY_STRONG_SNAPSHOT_VERSION = "weekly-strong-snapshot-v2";

// Deliberately zero dependency on market-data.service.ts - pure schema-level read/write/delete kept as its own tiny module so both market-data.service.ts and dashboard-snapshots.service.ts can depend on it one-directionally without a cycle.

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

// Superset of readDashboardSnapshot above - also surfaces asOfDate and evaluatorVersion so a caller can treat a stale-formula row as a miss and display the genuine as-of date; kept separate so existing weekly_strong callers keep their current behavior untouched.
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

// Deletes every metric snapshot for one scope - the invalidation half of "recompute on data change, not fixed TTL"; deleting rather than marking stale means one code path handles both "never generated" and "just invalidated".
export async function deleteDashboardSnapshots(
  scopeType: DashboardSnapshotScopeType,
  scopeKey: string
): Promise<void> {
  await db
    .delete(dashboardMetricSnapshots)
    .where(and(eq(dashboardMetricSnapshots.scopeType, scopeType), eq(dashboardMetricSnapshots.scopeKey, scopeKey)));
}
