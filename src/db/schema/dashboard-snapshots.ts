import { date, index, jsonb, pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

// Persisted, shared store for "current" Dashboard results (Relative
// Strength, Weekly Strong) - the expensive candles computation runs at most
// once per invalidation cycle and is read from here on every normal
// request. Uses Postgres rather than a new cache tier since Redis here is
// scoped to the BullMQ queue and is optional/degraded in some deployments
// (see worker.ts) - unsuitable as a source of truth that must survive a restart.
//
// scopeType/scopeKey is generic rather than a bare collectionId because two
// independent pools are snapshotted here: "collection" (a market_collections
// row's active-member pool, scopeKey = collection id) and "index_exchange"
// (a virtual index exchange's instrument pool, scopeKey = exchange code -
// indices aren't members of any market_collection).
export const dashboardSnapshotScopeTypeEnum = pgEnum("dashboard_snapshot_scope_type", [
  "collection",
  "index_exchange",
]);

// "relative_strength" holds the full base metrics array; the Index/Sector/
// Industry cards each cheaply derive their own view from this one stored
// base at read time, rather than each persisting its own recomputed slice.
// "weekly_strong" holds the passing-stocks array (collection scope only).
export const dashboardSnapshotMetricTypeEnum = pgEnum("dashboard_snapshot_metric_type", [
  "relative_strength",
  "weekly_strong",
]);

export const dashboardMetricSnapshots = pgTable(
  "dashboard_metric_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeType: dashboardSnapshotScopeTypeEnum("scope_type").notNull(),
    // A collection id or index exchange code depending on scopeType -
    // enforced at the application layer, not a DB constraint (Postgres
    // can't conditionally FK one of two different tables).
    scopeKey: varchar("scope_key", { length: 64 }).notNull(),
    metricType: dashboardSnapshotMetricTypeEnum("metric_type").notNull(),
    // The equity exchange candles were actually read from - kept for
    // traceability, and required for "index_exchange" scope rows, which
    // have no collection to derive it from.
    exchange: varchar("exchange", { length: 16 }).notNull(),
    // The market date this snapshot reflects (not derivable from
    // generatedAt, a wall-clock timestamp).
    asOfDate: date("as_of_date").notNull(),
    // Identifies which calculation version produced this snapshot - not a
    // hash of the proprietary formula, just a label so a future logic
    // change can't silently serve a result from a superseded version.
    evaluatorVersion: varchar("evaluator_version", { length: 32 }).notNull(),
    // The computed result only, never calculation logic. Typed as
    // `unknown[]` rather than importing market-data's row types, which
    // would create an import cycle (schema sits below most other modules);
    // callers narrow with `as T` (see dashboard-snapshot-store.ts).
    payload: jsonb("payload").$type<unknown[]>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // One current snapshot per (scope, metric) - holds "the current
    // result" only; a fresh compute upserts in place.
    scopeMetricUnique: unique().on(table.scopeType, table.scopeKey, table.metricType),
    scopeIdx: index("dashboard_metric_snapshots_scope_idx").on(table.scopeType, table.scopeKey),
  })
);
