CREATE TYPE "public"."monetization_mode" AS ENUM('off', 'preview', 'live');--> statement-breakpoint
CREATE TABLE "ad_placements" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"slot_id" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monetization_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"provider" varchar(32) DEFAULT 'adsense' NOT NULL,
	"mode" "monetization_mode" DEFAULT 'off' NOT NULL,
	"publisher_id" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
