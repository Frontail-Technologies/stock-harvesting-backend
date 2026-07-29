import { boolean, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { DEFAULT_EXCHANGE } from "../../shared/constants";
import { candleTimeframeEnum } from "./enums";
import { users } from "./users";

export const scannerDrawings = pgTable("scanner_drawings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  exchange: varchar("exchange", { length: 16 }).default(DEFAULT_EXCHANGE).notNull(),
  symbol: varchar("symbol", { length: 64 }).notNull(),
  timeframe: candleTimeframeEnum("timeframe").notNull(),
  drawingType: varchar("drawing_type", { length: 64 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  locked: boolean("locked").default(false).notNull(),
  hidden: boolean("hidden").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
