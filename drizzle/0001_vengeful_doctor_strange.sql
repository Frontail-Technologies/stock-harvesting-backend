CREATE TABLE "ai_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"model" varchar(64) DEFAULT 'gemini-2.5-flash' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scanner_drawings" ALTER COLUMN "exchange" SET DEFAULT 'US';--> statement-breakpoint
CREATE INDEX "instruments_exchange_active_symbol_idx" ON "instruments" USING btree ("exchange","active","symbol");--> statement-breakpoint
CREATE INDEX "instruments_exchange_active_name_idx" ON "instruments" USING btree ("exchange","active","name");