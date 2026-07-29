import { jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import type { EncryptedValue } from "../../modules/security/encryption";
import { PROVIDER_STATUS } from "../../shared/constants";
import { providerStatusEnum } from "./enums";

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
