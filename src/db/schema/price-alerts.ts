import { index, numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { DEFAULT_EXCHANGE } from "../../shared/constants";
import { users } from "./users";

export const priceAlerts = pgTable(
  "price_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    exchange: varchar("exchange", { length: 16 }).default(DEFAULT_EXCHANGE).notNull(),
    symbol: varchar("symbol", { length: 64 }).notNull(),
    condition: varchar("condition", { length: 16 }).notNull(),
    targetPrice: numeric("target_price", { precision: 18, scale: 4 }).notNull(),
    status: varchar("status", { length: 16 }).default("ACTIVE").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userExchangeSymbolIdx: index("price_alerts_user_exchange_symbol_idx").on(
      table.userId,
      table.exchange,
      table.symbol
    ),
    activeSymbolIdx: index("price_alerts_active_symbol_idx").on(
      table.exchange,
      table.symbol,
      table.status
    ),
  })
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("push_subscriptions_user_idx").on(table.userId),
  })
);
