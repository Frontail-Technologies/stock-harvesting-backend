import { date, index, integer, pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { marketCollectionVersions } from "./market-collection-versions";
import { marketCollections } from "./market-collections";
import { instruments } from "./market-data";

// "current_membership" uses today's live segment membership; "historical_membership" uses the point-in-time version effective for that week (see getCollectionMembershipAt) - the two modes are never mixed within one chart/series, see docs/BACKTEST.md.
export const weeklyStrongBacktestMembershipModeEnum = pgEnum("weekly_strong_backtest_membership_mode", [
  "current_membership",
  "historical_membership",
]);

// One row per (collection, completed week, membership mode); no passCount column since totalPassing below is just a denormalized cache and weeklyStrongBacktestMembers remains the real source of truth.
export const weeklyStrongBacktestRuns = pgTable(
  "weekly_strong_backtest_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => marketCollections.id, { onDelete: "cascade" })
      .notNull(),
    // Named weekEnding but stores aggregateWeeklyCandles' "first trading day of the ISO week" value, matching every other Weekly Strong surface - no new date convention.
    weekEnding: date("week_ending").notNull(),
    // Populated only for historical_membership runs (traceable provenance), NULL for current_membership; FK defaults to onDelete "restrict" so a version with runs pointing at it can't be silently deleted.
    membershipVersionId: uuid("membership_version_id").references(() => marketCollectionVersions.id),
    membershipMode: weeklyStrongBacktestMembershipModeEnum("membership_mode")
      .notNull()
      .default("current_membership"),
    // Version tag (e.g. "weekly-strong-v1") identifying the evaluator that produced this run, so future logic changes can tell old and new history apart; see weekly-strong-evaluator.ts.
    evaluatorVersion: varchar("evaluator_version", { length: 32 }).notNull(),
    totalPassing: integer("total_passing").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Idempotency: rerunning the same week/collection/membership mode updates in place, never duplicates.
    collectionWeekModeUnique: unique().on(table.collectionId, table.weekEnding, table.membershipMode),
    collectionWeekIdx: index("weekly_strong_backtest_runs_collection_week_idx").on(
      table.collectionId,
      table.weekEnding
    ),
  })
);

// The actual passing stocks for one run, read directly by the stacked chart/week-detail table with no recomputation.
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
    // Denormalized at generation time like symbol/name/exchange - a historical snapshot, not a live join, so later sector-reclassification syncs can't rewrite past weeks' displayed sector.
    sector: varchar("sector", { length: 255 }),
    industry: varchar("industry", { length: 255 }),
  },
  (table) => ({
    runInstrumentUnique: unique().on(table.runId, table.instrumentId),
    runIdx: index("weekly_strong_backtest_members_run_idx").on(table.runId),
  })
);
