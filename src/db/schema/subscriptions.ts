import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const subscriptionPlans = pgTable("subscription_plans", {
  code: varchar("code", { length: 32 }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  intervalMonths: integer("interval_months").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  currency: varchar("currency", { length: 3 }).default("INR").notNull(),
  version: integer("version").default(1).notNull(),
  razorpayPlanId: varchar("razorpay_plan_id", { length: 64 }).unique(),
  razorpayMode: varchar("razorpay_mode", { length: 8 }),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userSubscriptions = pgTable(
  "user_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 32 }).notNull().references(() => subscriptionPlans.code),
    pendingPlanCode: varchar("pending_plan_code", { length: 32 }).references(() => subscriptionPlans.code),
    provider: varchar("provider", { length: 24 }).default("razorpay").notNull(),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 64 }).notNull().unique(),
    status: varchar("status", { length: 32 }).default("created").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    providerPayload: jsonb("provider_payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("user_subscriptions_user_idx").on(table.userId),
    index("user_subscriptions_status_idx").on(table.status),
  ],
);

export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id").references(() => userSubscriptions.id, { onDelete: "set null" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerPaymentId: varchar("provider_payment_id", { length: 64 }).notNull().unique(),
    providerInvoiceId: varchar("provider_invoice_id", { length: 64 }),
    amountPaise: integer("amount_paise").notNull(),
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    providerPayload: jsonb("provider_payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("subscription_payments_user_idx").on(table.userId)],
);

export const subscriptionWebhookEvents = pgTable(
  "subscription_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerEventId: varchar("provider_event_id", { length: 128 }).notNull().unique(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 24 }).default("received").notNull(),
    errorMessage: text("error_message"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("subscription_webhook_status_idx").on(table.status, table.createdAt)],
);

export const subscriptionCoupons = pgTable(
  "subscription_coupons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull().unique(),
    codePrefix: varchar("code_prefix", { length: 16 }).notNull(),
    durationMonths: integer("duration_months").notNull(),
    maxRedemptions: integer("max_redemptions").notNull(),
    redemptionCount: integer("redemption_count").default(0).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("subscription_coupons_active_idx").on(table.enabled, table.expiresAt)],
);

export const subscriptionCouponRedemptions = pgTable(
  "subscription_coupon_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    couponId: uuid("coupon_id").notNull().references(() => subscriptionCoupons.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("subscription_coupon_user_unique").on(table.couponId, table.userId),
    index("subscription_coupon_redemptions_user_idx").on(table.userId),
  ],
);

export const subscriptionEntitlementGrants = pgTable(
  "subscription_entitlement_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 24 }).notNull(),
    sourceId: uuid("source_id"),
    reason: text("reason"),
    startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("subscription_entitlement_grants_user_idx").on(table.userId, table.revokedAt, table.endsAt),
  ],
);
