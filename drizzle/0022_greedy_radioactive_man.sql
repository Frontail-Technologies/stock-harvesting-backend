CREATE TABLE "widget_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "show_on_widget_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "market_collections" ADD COLUMN "widget_order" integer;--> statement-breakpoint
ALTER TABLE "widget_preferences" ADD CONSTRAINT "widget_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;