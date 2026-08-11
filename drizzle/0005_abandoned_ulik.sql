ALTER TABLE "instruments" ADD COLUMN "sector" varchar(255);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "sector_code" varchar(32);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "industry" varchar(255);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "industry_code" varchar(32);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "classification_synced_at" timestamp with time zone;