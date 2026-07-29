CREATE TABLE "market_collection_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_collection_members_collection_id_instrument_id_unique" UNIQUE("collection_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "market_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(160) NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"source_name" varchar(160),
	"source_date" date,
	"last_imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_collections_exchange_code_unique" UNIQUE("exchange","code")
);
--> statement-breakpoint
ALTER TABLE "market_collection_members" ADD CONSTRAINT "market_collection_members_collection_id_market_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."market_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_collection_members" ADD CONSTRAINT "market_collection_members_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;