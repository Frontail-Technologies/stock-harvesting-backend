ALTER TYPE "public"."background_job_run_status" ADD VALUE 'pending' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."background_job_run_status" ADD VALUE 'queued' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."background_job_run_status" ADD VALUE 'missed';--> statement-breakpoint
ALTER TABLE "background_job_runs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "trading_date" date;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "exchange" varchar(16);--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "bullmq_job_id" varchar(160);--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "total_expected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "completed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "missing_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "backtest_status" varchar(32);--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "backtest_through" date;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "background_job_runs_scheduled_status_idx" ON "background_job_runs" USING btree ("scheduled_at","status");--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_expected_job_unique" UNIQUE("trading_date","exchange","job_type");