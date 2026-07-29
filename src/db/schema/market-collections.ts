import {
  boolean,
  date,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { instruments } from "./market-data";

export const marketCollections = pgTable(
  "market_collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    description: text("description"),
    active: boolean("active").default(true).notNull(),
    sourceName: varchar("source_name", { length: 160 }),
    sourceDate: date("source_date"),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
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
