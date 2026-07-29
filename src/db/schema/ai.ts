import { integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

import type { EncryptedValue } from "../../modules/security/encryption";
import { AI_SETTINGS_DEFAULTS } from "../../shared/constants";

export const aiSettings = pgTable("ai_settings", {
  id: integer("id").primaryKey(),
  model: varchar("model", { length: 64 }).default(AI_SETTINGS_DEFAULTS.model).notNull(),
  encryptedApiKey: jsonb("encrypted_api_key").$type<EncryptedValue | null>(),
  apiKeyUpdatedAt: timestamp("api_key_updated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
