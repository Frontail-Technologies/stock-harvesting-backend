import { date, index, integer, pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { marketCollectionVersions } from "./market-collection-versions";
import { marketCollections } from "./market-collections";
import { instruments } from "./market-data";

// "current_membership" (Phase C2): generated against whatever the
// segment's CURRENT active membership is at generation time - recorded
// explicitly rather than silently presented as historically accurate
// point-in-time index membership. "historical_membership" (Phase D):
// generated against the collection's point-in-time membership version
// that was actually effective for that specific completed week (see
// getCollectionMembershipAt) - membershipVersionId below is always
// populated for these runs and NULL for current_membership runs. The two
// modes are never mixed within one chart/series - see
// weekly-strong-backtest.service.ts.
export const weeklyStrongBacktestMembershipModeEnum = pgEnum("weekly_strong_backtest_membership_mode", [
  "current_membership",
  "historical_membership",
]);

// One row per (collection, completed week, membership mode) - the
// "backtest bar" for that week. Deliberately no `passCount` column: it's
// derivable from weeklyStrongBacktestMembers (denormalized as
// totalPassing below purely so the stacked-bar/list APIs don't need a
// COUNT(*) join for the common case), but the members table is the real
// source of truth, never the other way around.
export const weeklyStrongBacktestRuns = pgTable(
  "weekly_strong_backtest_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => marketCollections.id, { onDelete: "cascade" })
      .notNull(),
    // The weekly candle's own `time` (aggregateWeeklyCandles' "first
    // trading day of the ISO week" convention - the same value
    // evaluateWeeklyStrongSeries already emits per point). Named
    // weekEnding to match the conceptual schema this was scoped from, but
    // the stored value follows the exact same week-labeling every other
    // Weekly Strong surface already uses - no new week/date convention.
    weekEnding: date("week_ending").notNull(),
    // Populated only for membershipMode = "historical_membership" - the
    // exact point-in-time snapshot this run was evaluated against, so
    // every historically-correct run is traceable to the precise version
    // used (Phase D requirement). NULL for current_membership runs, which
    // read whatever was active at generation time and don't reference a
    // version row. onDelete "restrict" (the FK default), not cascade: a
    // persisted run must never silently lose its provenance if a version
    // is ever removed - deleting a version that has runs pointing at it
    // must fail loudly instead.
    membershipVersionId: uuid("membership_version_id").references(() => marketCollectionVersions.id),
    membershipMode: weeklyStrongBacktestMembershipModeEnum("membership_mode")
      .notNull()
      .default("current_membership"),
    // A version tag for the evaluator that produced this run (e.g.
    // "weekly-strong-v1") - not a hash of the proprietary formula, just an
    // identifier so a future intentional logic change can tell old and
    // new history apart. See weekly-strong-evaluator.ts.
    evaluatorVersion: varchar("evaluator_version", { length: 32 }).notNull(),
    totalPassing: integer("total_passing").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Idempotency: rerunning the same week for the same collection under
    // the same membership mode updates in place, never duplicates.
    collectionWeekModeUnique: unique().on(table.collectionId, table.weekEnding, table.membershipMode),
    collectionWeekIdx: index("weekly_strong_backtest_runs_collection_week_idx").on(
      table.collectionId,
      table.weekEnding
    ),
  })
);

// The actual passing stocks for one run - what the stacked chart groups by
// sector and the week-detail table reads directly, with no recomputation.
export const weeklyStrongBacktestMembers = pgTable(
  "weekly_strong_backtest_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => weeklyStrongBacktestRuns.id, { onDelete: "cascade" })
      .notNull(),
    instrumentId: uuid("instrument_id")
      .references(() => instruments.id, { onDelete: "cascade" })
      .notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    // Denormalized from instruments at generation time (like symbol/name/
    // exchange above) - a member row is a historical snapshot of what
    // passed that week, not a live join, so a later sector-reclassification
    // sync can't silently rewrite past weeks' own displayed sector.
    sector: varchar("sector", { length: 255 }),
    industry: varchar("industry", { length: 255 }),
  },
  (table) => ({
    runInstrumentUnique: unique().on(table.runId, table.instrumentId),
    runIdx: index("weekly_strong_backtest_members_run_idx").on(table.runId),
  })
);
