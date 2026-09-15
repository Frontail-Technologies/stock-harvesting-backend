import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

export type WidgetPreferenceSource = { type: "segment" | "watchlist"; id: string };

// One row per user (unique userId) - row PRESENCE is the "has this user
// saved a preference yet" signal, distinct from `sources: []` (a
// deliberate "I removed everything" choice); see widget-preferences.service.ts.
export const widgetPreferences = pgTable("widget_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  sources: jsonb("sources").$type<WidgetPreferenceSource[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
