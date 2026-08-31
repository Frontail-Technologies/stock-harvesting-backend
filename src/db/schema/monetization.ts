import { boolean, pgTable, timestamp, varchar, integer } from "drizzle-orm/pg-core";

import { MONETIZATION_SETTINGS_DEFAULTS } from "../../shared/constants";
import { monetizationModeEnum } from "./enums";

// Singleton row (id fixed to 1), same pattern as branding_settings/ai_settings.
export const monetizationSettings = pgTable("monetization_settings", {
  id: integer("id").primaryKey(),
  provider: varchar("provider", { length: 32 })
    .default(MONETIZATION_SETTINGS_DEFAULTS.provider)
    .notNull(),
  mode: monetizationModeEnum("mode").default(MONETIZATION_SETTINGS_DEFAULTS.mode).notNull(),
  publisherId: varchar("publisher_id", { length: 32 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per stable placement key (see AD_PLACEMENTS in shared/constants) -
// rows are seeded on first read, never admin-created/deleted, so `key` is a
// plain unique column rather than a FK-driven child table.
export const adPlacements = pgTable("ad_placements", {
  key: varchar("key", { length: 64 }).primaryKey(),
  enabled: boolean("enabled").default(false).notNull(),
  slotId: varchar("slot_id", { length: 32 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
