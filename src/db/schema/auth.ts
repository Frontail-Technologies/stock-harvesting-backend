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
  // Strict portal separation (item 7) - a stored, server-side signal an
  // admin refresh token belongs to the ADMIN portal, and a user refresh
  // token belongs to the USER portal, checked on every rotation
  // (auth.service.ts's rotateRefreshToken) so one portal's refresh token
  // can never rotate into the other portal's session, regardless of which
  // cookie/endpoint happens to present it. Existing rows predate portal
  // separation and were all issued to the (only, at the time) user portal.
  portal: varchar("portal", { length: 16 }).notNull().default("user"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
