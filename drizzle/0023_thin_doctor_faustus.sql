CREATE TYPE "public"."background_job_run_status" AS ENUM('running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "background_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" varchar(64) NOT NULL,
	"status" "background_job_run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"repaired_count" integer DEFAULT 0 NOT NULL,
	"already_current_count" integer DEFAULT 0 NOT NULL,
	"bootstrap_required_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "background_job_runs_job_type_started_at_idx" ON "background_job_runs" USING btree ("job_type","started_at" DESC NULLS LAST);