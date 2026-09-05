import { index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const registrationVerifications = pgTable(
  "registration_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    otpHash: text("otp_hash").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resendAvailableAt: timestamp("resend_available_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    emailIdx: index("registration_verifications_email_idx").on(table.email),
    activeIdx: index("registration_verifications_active_idx").on(table.email, table.consumedAt),
  })
);
