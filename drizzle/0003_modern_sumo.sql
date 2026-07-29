ALTER TABLE "ai_settings" ALTER COLUMN "model" SET DEFAULT 'gemini-flash-latest';--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "latest_close" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "latest_open" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "latest_volume" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "latest_change_pct" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "latest_price_at" date;--> statement-breakpoint
CREATE INDEX "instruments_exchange_active_change_pct_idx" ON "instruments" USING btree ("exchange","active","latest_change_pct");