import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { backgroundJobRunStatusEnum } from "./enums";

export const backgroundJobRuns = pgTable(
  "background_job_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobType: varchar("job_type", { length: 64 }).notNull(),
    status: backgroundJobRunStatusEnum("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    processedCount: integer("processed_count").default(0).notNull(),
    updatedCount: integer("updated_count").default(0).notNull(),
    repairedCount: integer("repaired_count").default(0).notNull(),
    alreadyCurrentCount: integer("already_current_count").default(0).notNull(),
    bootstrapRequiredCount: integer("bootstrap_required_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    errorSummary: text("error_summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    jobTypeStartedAtIdx: index("background_job_runs_job_type_started_at_idx").on(
      table.jobType,
      table.startedAt.desc()
    ),
  })
);
