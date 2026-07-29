import { boolean, date, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { JOB_STATUS } from "../../shared/constants";
import { candleTimeframeEnum, scanRunStatusEnum } from "./enums";

export const scanRules = pgTable("scan_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 128 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scanRuns = pgTable("scan_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  ruleId: uuid("rule_id").references(() => scanRules.id, { onDelete: "set null" }),
  status: scanRunStatusEnum("status").default(JOB_STATUS.queued).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scanResults = pgTable("scan_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => scanRuns.id, { onDelete: "cascade" })
    .notNull(),
  ruleKey: varchar("rule_key", { length: 128 }).notNull(),
  exchange: varchar("exchange", { length: 16 }).notNull(),
  symbol: varchar("symbol", { length: 64 }).notNull(),
  timeframe: candleTimeframeEnum("timeframe").notNull(),
  startTime: date("start_time").notNull(),
  endTime: date("end_time").notNull(),
  highlightTimes: jsonb("highlight_times").$type<string[]>().default([]).notNull(),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
