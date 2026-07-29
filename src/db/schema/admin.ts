import { integer, jsonb, pgTable, text, timestamp, uuid, varchar, boolean } from "drizzle-orm/pg-core";

import { BRANDING_DEFAULTS, JOB_STATUS } from "../../shared/constants";
import { jobStatusEnum } from "./enums";
import { users } from "./users";

export const syncJobs = pgTable("sync_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: varchar("type", { length: 128 }).notNull(),
  status: jobStatusEnum("status").default(JOB_STATUS.queued).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const brandingSettings = pgTable("branding_settings", {
  id: integer("id").primaryKey(),
  brandName: varchar("brand_name", { length: 120 })
    .default(BRANDING_DEFAULTS.brandName)
    .notNull(),
  watermarkText: varchar("watermark_text", { length: 160 })
    .default(BRANDING_DEFAULTS.watermarkText)
    .notNull(),
  logoUrl: text("logo_url"),
  enabled: boolean("enabled").default(true).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  action: varchar("action", { length: 160 }).notNull(),
  targetType: varchar("target_type", { length: 120 }),
  targetId: varchar("target_id", { length: 160 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
