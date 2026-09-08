import {
  boolean,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { collectionPreparationStatusEnum } from "./enums";
import { instruments } from "./market-data";

export const marketCollections = pgTable(
  "market_collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    // ISO-3166 alpha-2, e.g. "IN" - every collection today is BSE/India, backfilled via this column's own NOT NULL DEFAULT.
    countryCode: varchar("country_code", { length: 2 }).default("IN").notNull(),
    description: text("description"),
    active: boolean("active").default(true).notNull(),
    sourceName: varchar("source_name", { length: 160 }),
    sourceDate: date("source_date"),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
    // Candle backfill + backtest readiness for the CURRENT membership - reset to "pending" on every import so a stale READY badge never survives.
    preparationStatus: collectionPreparationStatusEnum("preparation_status")
      .default("pending")
      .notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    preparationError: text("preparation_error"),
    membersWithRequiredHistory: integer("members_with_required_history"),
    membersUnavailable: integer("members_unavailable"),
    // The market_collection_versions row from the import that last reset preparationStatus - re-checked before the final write so a stale job can't mark a superseded membership READY.
    latestMembershipVersionId: uuid("latest_membership_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    exchangeCodeUnique: unique().on(table.exchange, table.code),
  })
);

export const marketCollectionMembers = pgTable(
  "market_collection_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => marketCollections.id, { onDelete: "cascade" })
      .notNull(),
    instrumentId: uuid("instrument_id")
      .references(() => instruments.id, { onDelete: "cascade" })
      .notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    memberUnique: unique().on(table.collectionId, table.instrumentId),
  })
);
