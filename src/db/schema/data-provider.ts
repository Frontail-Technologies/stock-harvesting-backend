import { boolean, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import type { EncryptedValue } from "../../modules/security/encryption";
import { PROVIDER_STATUS } from "../../shared/constants";
import { providerStatusEnum } from "./enums";
import { users } from "./users";

export const dataProviderConnections = pgTable("data_provider_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: varchar("provider", { length: 64 }).notNull(),
  status: providerStatusEnum("status").default(PROVIDER_STATUS.disconnected).notNull(),
  encryptedAccessToken: jsonb("encrypted_access_token").$type<EncryptedValue | null>(),
  encryptedRefreshToken: jsonb("encrypted_refresh_token").$type<EncryptedValue | null>(),
  encryptedAccountId: jsonb("encrypted_account_id").$type<EncryptedValue | null>(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Admin-controlled operational state (enabled/priority) — deliberately
// separate from data_provider_connections above, which tracks OAuth session
// health (connected/expired/error), a different concept from "is an admin
// allowing this provider to be used at all". One row per provider key,
// seeded on first read (see data-provider-settings.service.ts) rather than
// admin-creatable, so `key` is a plain unique column, not FK-driven.
export const dataProviderSettings = pgTable("data_provider_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 32 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  priority: integer("priority").default(100).notNull(),
  disabledReason: varchar("disabled_reason", { length: 200 }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});
