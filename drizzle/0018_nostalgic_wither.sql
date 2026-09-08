CREATE TYPE "public"."collection_preparation_status" AS ENUM('pending', 'syncing_candles', 'building_backtest', 'ready', 'partial', 'failed');--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "preparation_status" "collection_preparation_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "preparation_error" text;--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "members_with_required_history" integer;--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "members_unavailable" integer;--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "latest_membership_version_id" uuid;