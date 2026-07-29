CREATE TYPE "public"."candle_timeframe" AS ENUM('1D', '1W', '1M');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('disconnected', 'connected', 'expired', 'error');--> statement-breakpoint
CREATE TYPE "public"."scan_run_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_plan" AS ENUM('free', 'pro');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(160) NOT NULL,
	"target_type" varchar(120),
	"target_id" varchar(160),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_accounts_provider_provider_account_id_unique" UNIQUE("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "branding_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"brand_name" varchar(120) DEFAULT 'Stock Harvesting' NOT NULL,
	"watermark_text" varchar(160) DEFAULT 'Stock Harvesting' NOT NULL,
	"logo_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid,
	"exchange" varchar(16) NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"timeframe" "candle_timeframe" NOT NULL,
	"time" date NOT NULL,
	"open" numeric(18, 4) NOT NULL,
	"high" numeric(18, 4) NOT NULL,
	"low" numeric(18, 4) NOT NULL,
	"close" numeric(18, 4) NOT NULL,
	"volume" numeric(20, 0) NOT NULL,
	"source" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candles_exchange_symbol_timeframe_time_unique" UNIQUE("exchange","symbol","timeframe","time")
);
--> statement-breakpoint
CREATE TABLE "data_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(64) NOT NULL,
	"status" "provider_status" DEFAULT 'disconnected' NOT NULL,
	"encrypted_access_token" jsonb,
	"encrypted_refresh_token" jsonb,
	"encrypted_account_id" jsonb,
	"expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(64) NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"instrument_token" varchar(64) NOT NULL,
	"segment" varchar(64),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_exchange_symbol_unique" UNIQUE("exchange","symbol"),
	CONSTRAINT "instruments_provider_instrument_token_unique" UNIQUE("provider","instrument_token")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"replaced_by_token_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "scan_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"rule_key" varchar(128) NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"timeframe" "candle_timeframe" NOT NULL,
	"start_time" date NOT NULL,
	"end_time" date NOT NULL,
	"highlight_times" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_rules_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid,
	"status" "scan_run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scanner_drawings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"exchange" varchar(16) DEFAULT 'NSE' NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"timeframe" "candle_timeframe" NOT NULL,
	"drawing_type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(128) NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"plan" "user_plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_results" ADD CONSTRAINT "scan_results_run_id_scan_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_rule_id_scan_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."scan_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_drawings" ADD CONSTRAINT "scanner_drawings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;