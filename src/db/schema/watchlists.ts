import { index, integer, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const watchlists = pgTable(
  "watchlists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("watchlists_user_idx").on(table.userId),
  })
);

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    watchlistId: uuid("watchlist_id")
      .references(() => watchlists.id, { onDelete: "cascade" })
      .notNull(),
    exchange: varchar("exchange", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    watchlistIdx: index("watchlist_items_watchlist_idx").on(table.watchlistId),
    itemUnique: unique("watchlist_items_watchlist_exchange_symbol_unique").on(
      table.watchlistId,
      table.exchange,
      table.symbol
    ),
  })
);
