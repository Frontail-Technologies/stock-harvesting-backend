CREATE TABLE "subscription_coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"code_prefix" varchar(16) NOT NULL,
	"duration_months" integer NOT NULL,
	"max_redemptions" integer NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_coupons_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "subscription_entitlement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" varchar(24) NOT NULL,
	"source_id" uuid,
	"reason" text,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid,
	"user_id" uuid NOT NULL,
	"provider_payment_id" varchar(64) NOT NULL,
	"provider_invoice_id" varchar(64),
	"amount_paise" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"status" varchar(32) NOT NULL,
	"paid_at" timestamp with time zone,
	"provider_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_provider_payment_id_unique" UNIQUE("provider_payment_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"interval_months" integer NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"razorpay_plan_id" varchar(64),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_razorpay_plan_id_unique" UNIQUE("razorpay_plan_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'received' NOT NULL,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_webhook_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"pending_plan_code" varchar(32),
	"provider" varchar(24) DEFAULT 'razorpay' NOT NULL,
	"provider_subscription_id" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'created' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"provider_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_subscriptions_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "subscription_coupon_redemptions" ADD CONSTRAINT "subscription_coupon_redemptions_coupon_id_subscription_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."subscription_coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_coupon_redemptions" ADD CONSTRAINT "subscription_coupon_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_coupons" ADD CONSTRAINT "subscription_coupons_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_entitlement_grants" ADD CONSTRAINT "subscription_entitlement_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_entitlement_grants" ADD CONSTRAINT "subscription_entitlement_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_user_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_code_subscription_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."subscription_plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_pending_plan_code_subscription_plans_code_fk" FOREIGN KEY ("pending_plan_code") REFERENCES "public"."subscription_plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_coupon_user_unique" ON "subscription_coupon_redemptions" USING btree ("coupon_id","user_id");--> statement-breakpoint
CREATE INDEX "subscription_coupon_redemptions_user_idx" ON "subscription_coupon_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_coupons_active_idx" ON "subscription_coupons" USING btree ("enabled","expires_at");--> statement-breakpoint
CREATE INDEX "subscription_entitlement_grants_user_idx" ON "subscription_entitlement_grants" USING btree ("user_id","revoked_at","ends_at");--> statement-breakpoint
CREATE INDEX "subscription_payments_user_idx" ON "subscription_payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_webhook_status_idx" ON "subscription_webhook_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "user_subscriptions_user_idx" ON "user_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_subscriptions_status_idx" ON "user_subscriptions" USING btree ("status");
--> statement-breakpoint
INSERT INTO "subscription_plans" ("code", "name", "interval_months", "amount_paise", "currency", "version", "active") VALUES
('pro-monthly', 'Pro Monthly', 1, 59900, 'INR', 1, true),
('pro-quarterly', 'Pro Quarterly', 3, 165000, 'INR', 1, true),
('pro-half-yearly', 'Pro Half-yearly', 6, 300000, 'INR', 1, true),
('pro-yearly', 'Pro Yearly', 12, 550000, 'INR', 1, true)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_entitlement_grants" ("user_id", "source", "reason")
SELECT "id", 'grandfathered', 'Existing Pro access migrated at subscription launch'
FROM "users"
WHERE "plan" = 'pro' AND "role" = 'user';
