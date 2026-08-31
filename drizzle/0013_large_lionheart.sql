ALTER TYPE "public"."weekly_strong_backtest_membership_mode" ADD VALUE 'historical_membership';--> statement-breakpoint
CREATE TABLE "market_collection_version_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"symbol" varchar(64) NOT NULL,
	"exchange" varchar(16) NOT NULL,
	CONSTRAINT "market_collection_version_members_version_id_instrument_id_unique" UNIQUE("version_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "market_collection_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"source_name" varchar(160),
	"source_date" date,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"member_count" integer NOT NULL,
	CONSTRAINT "market_collection_versions_collection_id_effective_from_unique" UNIQUE("collection_id","effective_from")
);
--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "country_code" varchar(2) DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "market_collection_version_members" ADD CONSTRAINT "market_collection_version_members_version_id_market_collection_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."market_collection_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_collection_version_members" ADD CONSTRAINT "market_collection_version_members_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_collection_versions" ADD CONSTRAINT "market_collection_versions_collection_id_market_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."market_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_collection_versions" ADD CONSTRAINT "market_collection_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_collection_version_members_version_idx" ON "market_collection_version_members" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "market_collection_versions_collection_effective_idx" ON "market_collection_versions" USING btree ("collection_id","effective_from");--> statement-breakpoint
ALTER TABLE "weekly_strong_backtest_runs" ADD CONSTRAINT "weekly_strong_backtest_runs_membership_version_id_market_collection_versions_id_fk" FOREIGN KEY ("membership_version_id") REFERENCES "public"."market_collection_versions"("id") ON DELETE no action ON UPDATE no action;