import { date, index, integer, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { marketCollections } from "./market-collections";
import { instruments } from "./market-data";
import { users } from "./users";

// An IMMUTABLE point-in-time snapshot of a collection's full constituent
// list, created on every confirmed (non-dry-run) admin import - alongside,
// not instead of, market_collection_members' existing active-boolean
// model, which stays the source of truth for current/live Dashboard reads.
// Never updated in place once created; a
// correction creates a new snapshot for the SAME version id via an
// explicit replace workflow (market-collection-versions.service.ts),
// never a silent overwrite of member rows.
export const marketCollectionVersions = pgTable(
  "market_collection_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => marketCollections.id, { onDelete: "cascade" })
      .notNull(),
    // The date this snapshot becomes authoritative for point-in-time
    // membership resolution (see getCollectionMembershipAt) - compared
    // directly against a completed week's own weekEnding date, the same
    // value every other Weekly Strong surface already uses. Never the
    // upload timestamp.
    effectiveFrom: date("effective_from").notNull(),
    sourceName: varchar("source_name", { length: 160 }),
    sourceDate: date("source_date"),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    memberCount: integer("member_count").notNull(),
  },
  (table) => ({
    collectionEffectiveFromUnique: unique().on(table.collectionId, table.effectiveFrom),
    collectionEffectiveFromIdx: index("market_collection_versions_collection_effective_idx").on(
      table.collectionId,
      table.effectiveFrom
    ),
  })
);

// The snapshot's own member list - just the point-in-time membership FACT
// (instrument + the symbol/exchange it traded under then). Deliberately
// no sector/industry here: classification is "best current knowledge",
// re-synced independently over time, and is joined against `instruments`
// live at rebuild time (same pattern the current_membership path already
// uses) rather than frozen at import time - freezing it would mean a
// later classification correction could never reach old backtest reruns.
export const marketCollectionVersionMembers = pgTable(
  "market_collection_version_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .references(() => marketCollectionVersions.id, { onDelete: "cascade" })
      .notNull(),
    instrumentId: uuid("instrument_id")
      .references(() => instruments.id, { onDelete: "cascade" })
      .notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
  },
  (table) => ({
    versionInstrumentUnique: unique().on(table.versionId, table.instrumentId),
    versionIdx: index("market_collection_version_members_version_idx").on(table.versionId),
  })
);
