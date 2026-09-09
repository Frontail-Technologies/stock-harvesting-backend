CREATE TYPE "public"."candle_bootstrap_status" AS ENUM('success', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "candle_bootstrap_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"timeframe" "candle_timeframe" NOT NULL,
	"kind" varchar(64) NOT NULL,
	"bootstrap_version" integer NOT NULL,
	"status" "candle_bootstrap_status" NOT NULL,
	"requested_from" date NOT NULL,
	"requested_to" date,
	"completed_at" timestamp with time zone,
	"candle_count" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candle_bootstrap_checkpoints_exchange_symbol_timeframe_kind_unique" UNIQUE("exchange","symbol","timeframe","kind")
);
