import { date, index, jsonb, pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

// Phase D.10 performance architecture: the persisted, shared, multi-
// instance-safe store for "current" Dashboard results (Relative Strength,
// Weekly Strong) - the expensive years-of-candles computation now happens
// at most once per invalidation cycle (a real market-data sync, an admin
// import, or this row simply not existing yet) and gets READ from here on
// every normal Dashboard request, instead of every request recomputing it
// live. This intentionally reuses the project's existing shared database
// (Neon Postgres) rather than introducing a new cache tier (e.g. Redis-as-
// cache) - Postgres is already this app's one shared, persistent,
// multi-instance-safe store (candles, backtest runs, membership versions
// all already live here), and the existing Redis usage is scoped to the
// BullMQ job queue only, and is itself optional/degraded in some
// deployments (see worker.ts) - unsuitable as the SOURCE OF TRUTH for
// something that must survive a restart.
//
// Two independent "pools" get snapshotted under this one table, hence the
// generic scopeType/scopeKey pair rather than a bare collectionId column:
//  - "collection": a market_collections row's own active-member pool
//    (scopeKey = that collection's id) - backs the Sector/Industry cards
//    and the Weekly Strong table/card.
//  - "index_exchange": the index-instrument pool for one virtual index
//    exchange, e.g. "BSE_IDX" (scopeKey = that exchange code) - backs the
//    Index card. Indices aren't members of any market_collection, so this
//    can't be keyed by collectionId at all.
export const dashboardSnapshotScopeTypeEnum = pgEnum("dashboard_snapshot_scope_type", [
  "collection",
  "index_exchange",
]);

// "relative_strength" holds the FULL base metrics array
// (RelativeStrengthMetricRow[], pre-limit/pre-groupBy) - the Index card
// (scope "index_exchange"), and the Sector/Industry cards (scope
// "collection") are all cheaply DERIVED from this same stored base at read
// time (pickTopRelativeStrengthRows / groupRelativeStrengthMetrics -
// pure, no candle I/O), rather than each being its own separately
// persisted/recomputed slice - the whole point of Phase D.10 #1 was that
// the expensive base calculation happens ONCE, not once per derived view.
// "weekly_strong" (scope "collection" only) holds the passing-stocks
// array (WeeklyStrongStockRow[]) computeWeeklyStrongStocks produces.
export const dashboardSnapshotMetricTypeEnum = pgEnum("dashboard_snapshot_metric_type", [
  "relative_strength",
  "weekly_strong",
]);

export const dashboardMetricSnapshots = pgTable(
  "dashboard_metric_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeType: dashboardSnapshotScopeTypeEnum("scope_type").notNull(),
    // A collection id (uuid, stored as text) or an index exchange code
    // ("BSE_IDX") depending on scopeType - never both meanings in the same
    // row, enforced at the application layer (not a DB constraint, since
    // Postgres has no clean way to make a text column conditionally FK
    // one of two different tables).
    scopeKey: varchar("scope_key", { length: 64 }).notNull(),
    metricType: dashboardSnapshotMetricTypeEnum("metric_type").notNull(),
    // The real equity exchange candles were actually read from (e.g.
    // "BSE") - kept for traceability/debugging even though it's usually
    // derivable from the collection, since "index_exchange" scope rows
    // have no collection to derive it from.
    exchange: varchar("exchange", { length: 16 }).notNull(),
    // The latest expected trading day as of generation - not a formula
    // detail, just "what market date does this snapshot reflect", so a
    // stale-looking snapshot can be reasoned about without re-deriving it
    // from generatedAt (which is a wall-clock timestamp, not a market
    // date).
    asOfDate: date("as_of_date").notNull(),
    // A version tag for whichever calculation produced this snapshot
    // (e.g. "relative-strength-v1", or the shared
    // WEEKLY_STRONG_EVALUATOR_VERSION for metricType="weekly_strong") -
    // not a hash of the proprietary formula, just an identifier so a
    // future intentional logic change can tell old and new snapshots
    // apart and never silently serves a result computed by a superseded
    // formula version.
    evaluatorVersion: varchar("evaluator_version", { length: 32 }).notNull(),
    // The actual computed result (RelativeStrengthMetricRow[] or
    // WeeklyStrongStockRow[], depending on metricType) - never the
    // calculation logic itself, only its numeric output.
    payload: jsonb("payload").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // One current snapshot per (scope, metric) - this table holds "the
    // current result", not a history (Backtest already covers the
    // historical dimension separately) - a fresh compute upserts in
    // place rather than accumulating rows.
    scopeMetricUnique: unique().on(table.scopeType, table.scopeKey, table.metricType),
    scopeIdx: index("dashboard_metric_snapshots_scope_idx").on(table.scopeType, table.scopeKey),
  })
);
