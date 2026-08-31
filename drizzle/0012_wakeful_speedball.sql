CREATE TYPE "public"."weekly_strong_backtest_membership_mode" AS ENUM('current_membership');--> statement-breakpoint
CREATE TABLE "weekly_strong_backtest_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"sector" varchar(255),
	"industry" varchar(255),
	CONSTRAINT "weekly_strong_backtest_members_run_id_instrument_id_unique" UNIQUE("run_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "weekly_strong_backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"week_ending" date NOT NULL,
	"membership_version_id" uuid,
	"membership_mode" "weekly_strong_backtest_membership_mode" DEFAULT 'current_membership' NOT NULL,
	"evaluator_version" varchar(32) NOT NULL,
	"total_passing" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_strong_backtest_runs_collection_id_week_ending_membership_mode_unique" UNIQUE("collection_id","week_ending","membership_mode")
);
--> statement-breakpoint
ALTER TABLE "weekly_strong_backtest_members" ADD CONSTRAINT "weekly_strong_backtest_members_run_id_weekly_strong_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."weekly_strong_backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_strong_backtest_members" ADD CONSTRAINT "weekly_strong_backtest_members_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_strong_backtest_runs" ADD CONSTRAINT "weekly_strong_backtest_runs_collection_id_market_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."market_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_strong_backtest_members_run_idx" ON "weekly_strong_backtest_members" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "weekly_strong_backtest_runs_collection_week_idx" ON "weekly_strong_backtest_runs" USING btree ("collection_id","week_ending");