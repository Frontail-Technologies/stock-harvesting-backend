import { date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { backgroundJobRunStatusEnum } from "./enums";

export const backgroundJobRuns = pgTable(
  "background_job_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobType: varchar("job_type", { length: 64 }).notNull(),
    status: backgroundJobRunStatusEnum("status").notNull(),
    tradingDate: date("trading_date"),
    exchange: varchar("exchange", { length: 16 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    bullmqJobId: varchar("bullmq_job_id", { length: 160 }),
    totalExpected: integer("total_expected").default(0).notNull(),
    completedCount: integer("completed_count").default(0).notNull(),
    missingCount: integer("missing_count").default(0).notNull(),
    backtestStatus: varchar("backtest_status", { length: 32 }),
    backtestThrough: date("backtest_through"),
    processedCount: integer("processed_count").default(0).notNull(),
    updatedCount: integer("updated_count").default(0).notNull(),
    repairedCount: integer("repaired_count").default(0).notNull(),
    alreadyCurrentCount: integer("already_current_count").default(0).notNull(),
    bootstrapRequiredCount: integer("bootstrap_required_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    errorSummary: text("error_summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    jobTypeStartedAtIdx: index("background_job_runs_job_type_started_at_idx").on(
      table.jobType,
      table.startedAt.desc()
    ),
    expectedJobUnique: unique("background_job_runs_expected_job_unique").on(
      table.tradingDate,
      table.exchange,
      table.jobType,
    ),
    scheduledStatusIdx: index("background_job_runs_scheduled_status_idx").on(
      table.scheduledAt,
      table.status,
    ),
  })
);
