import { pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerAccountUnique: unique().on(table.provider, table.providerAccountId),
  })
);

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: uuid("family_id").notNull(),
  replacedByTokenId: uuid("replaced_by_token_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
