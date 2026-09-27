ALTER TABLE "instruments" ADD COLUMN "last_candle_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "last_candle_refresh_target_date" date;