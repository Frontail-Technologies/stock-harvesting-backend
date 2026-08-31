CREATE TYPE "public"."dashboard_snapshot_metric_type" AS ENUM('relative_strength', 'weekly_strong');--> statement-breakpoint
CREATE TYPE "public"."dashboard_snapshot_scope_type" AS ENUM('collection', 'index_exchange');--> statement-breakpoint
CREATE TABLE "dashboard_metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "dashboard_snapshot_scope_type" NOT NULL,
	"scope_key" varchar(64) NOT NULL,
	"metric_type" "dashboard_snapshot_metric_type" NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"as_of_date" date NOT NULL,
	"evaluator_version" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_metric_snapshots_scope_type_scope_key_metric_type_unique" UNIQUE("scope_type","scope_key","metric_type")
);
--> statement-breakpoint
CREATE INDEX "dashboard_metric_snapshots_scope_idx" ON "dashboard_metric_snapshots" USING btree ("scope_type","scope_key");