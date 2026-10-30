import { createHash, randomBytes } from "crypto";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  subscriptionCouponRedemptions,
  subscriptionCoupons,
  subscriptionEntitlementGrants,
  subscriptionPayments,
  subscriptionPlans,
  subscriptionWebhookEvents,
  userSubscriptions,
  users,
} from "../../db/schema";
import { badRequest, conflict, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { env } from "../../shared/env";
import {
  cancelRazorpaySubscription,
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  getRazorpayPublicKey,
  scheduleRazorpayPlanChange,
  type RazorpaySubscription,
} from "./razorpay.client";
import { refreshUserPlan, hasEffectivePro } from "./entitlements.service";
import { SUBSCRIPTION_CATALOG, SUBSCRIPTION_GRACE_MS } from "./subscriptions.constants";

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function fromUnix(value?: number) {
  return value ? new Date(value * 1000) : null;
}

function hashCoupon(code: string) {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function generateCouponCode() {
  const token = randomBytes(9).toString("base64url").toUpperCase();
  return `SH-${token}`;
}

export async function ensureSubscriptionCatalog() {
  for (const plan of SUBSCRIPTION_CATALOG) {
    await db.insert(subscriptionPlans).values({ ...plan, currency: "INR", version: 1 }).onConflictDoUpdate({
      target: subscriptionPlans.code,
      set: { name: plan.name, intervalMonths: plan.intervalMonths, amountPaise: plan.amountPaise, active: true, updatedAt: new Date() },
    });
  }
}

export async function listPublicPlans() {
  await ensureSubscriptionCatalog();
  const plans = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.active, true)).orderBy(subscriptionPlans.intervalMonths);
  return plans.map(({ razorpayPlanId: _private, ...plan }) => plan);
}

export async function getBillingOverview(userId: string) {
  await refreshUserPlan(userId);
  const [subscription, payments, grants, user] = await Promise.all([
    db.select({ subscription: userSubscriptions, plan: subscriptionPlans }).from(userSubscriptions)
      .innerJoin(subscriptionPlans, eq(userSubscriptions.planCode, subscriptionPlans.code))
      .where(eq(userSubscriptions.userId, userId)).orderBy(desc(userSubscriptions.createdAt)).limit(1),
    db.select().from(subscriptionPayments).where(eq(subscriptionPayments.userId, userId)).orderBy(desc(subscriptionPayments.createdAt)).limit(50),
    db.select().from(subscriptionEntitlementGrants).where(and(eq(subscriptionEntitlementGrants.userId, userId), isNull(subscriptionEntitlementGrants.revokedAt))).orderBy(desc(subscriptionEntitlementGrants.createdAt)),
    db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return { plan: user[0]?.plan ?? "free", subscription: subscription[0] ?? null, payments, grants };
}

export async function createCheckout(userId: string, planCode: string) {
  if (await hasEffectivePro(userId)) throw conflict("You already have active Pro access");
  await ensureSubscriptionCatalog();
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!user) throw notFound("User not found");
    const [plan, existing] = await Promise.all([
      tx.select().from(subscriptionPlans).where(and(eq(subscriptionPlans.code, planCode), eq(subscriptionPlans.active, true))).limit(1),
      tx.select().from(userSubscriptions).where(and(eq(userSubscriptions.userId, userId), inArray(userSubscriptions.status, ["created", "authenticated", "active", "pending", "halted"]))).limit(1),
    ]);
    if (!plan[0]) throw notFound("Subscription plan not found");
    if (!plan[0].razorpayPlanId || plan[0].razorpayMode !== env.RAZORPAY_MODE) throw conflict("Subscription plan is not configured for this Razorpay mode");
    if (existing[0]) {
      if (existing[0].status === "created" && existing[0].planCode === planCode) {
        return { subscriptionId: existing[0].id, providerSubscriptionId: existing[0].providerSubscriptionId, keyId: getRazorpayPublicKey() };
      }
      throw conflict("A subscription is already in progress");
    }
    const provider = await createRazorpaySubscription({ planId: plan[0].razorpayPlanId, userId, email: user.email, planCode });
    const [created] = await tx.insert(userSubscriptions).values({
      userId,
      planCode,
      providerSubscriptionId: provider.id,
      status: provider.status || "created",
      currentPeriodStart: fromUnix(provider.current_start),
      currentPeriodEnd: fromUnix(provider.current_end),
      providerPayload: provider as unknown as Record<string, unknown>,
    }).returning();
    return { subscriptionId: created.id, providerSubscriptionId: provider.id, keyId: getRazorpayPublicKey() };
  });
}

export async function cancelUserSubscription(userId: string, id: string) {
  const [row] = await db.select().from(userSubscriptions).where(and(eq(userSubscriptions.id, id), eq(userSubscriptions.userId, userId))).limit(1);
  if (!row) throw notFound("Subscription not found");
  if (["cancelled", "completed", "expired"].includes(row.status)) throw conflict("Subscription is already ending or ended");
  const provider = await cancelRazorpaySubscription(row.providerSubscriptionId);
  await applyProviderSubscription(provider, row.userId);
  await db.update(userSubscriptions).set({ cancelAtPeriodEnd: true, cancelledAt: new Date(), updatedAt: new Date() }).where(eq(userSubscriptions.id, row.id));
  return getBillingOverview(userId);
}

export async function changeUserSubscriptionPlan(userId: string, id: string, planCode: string) {
  const [row, plan] = await Promise.all([
    db.select().from(userSubscriptions).where(and(eq(userSubscriptions.id, id), eq(userSubscriptions.userId, userId))).limit(1),
    db.select().from(subscriptionPlans).where(and(eq(subscriptionPlans.code, planCode), eq(subscriptionPlans.active, true))).limit(1),
  ]);
  if (!row[0]) throw notFound("Subscription not found");
  if (!plan[0]?.razorpayPlanId) throw conflict("Target plan is not configured");
  if (row[0].planCode === planCode) throw badRequest("That billing cycle is already active");
  await scheduleRazorpayPlanChange(row[0].providerSubscriptionId, plan[0].razorpayPlanId);
  await db.update(userSubscriptions).set({ pendingPlanCode: planCode, updatedAt: new Date() }).where(eq(userSubscriptions.id, row[0].id));
  return getBillingOverview(userId);
}

export async function redeemCoupon(userId: string, rawCode: string) {
  if (await hasEffectivePro(userId)) throw conflict("Active Pro users cannot redeem a coupon");
  const now = new Date();
  const codeHash = hashCoupon(rawCode);
  const result = await db.transaction(async (tx) => {
    const [lockedUser] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!lockedUser) throw notFound("User not found");
    const [activeGrant, activeSubscription] = await Promise.all([
      tx.select({ id: subscriptionEntitlementGrants.id }).from(subscriptionEntitlementGrants).where(and(
        eq(subscriptionEntitlementGrants.userId, userId),
        isNull(subscriptionEntitlementGrants.revokedAt),
        sql`${subscriptionEntitlementGrants.startsAt} <= ${now}`,
        sql`(${subscriptionEntitlementGrants.endsAt} IS NULL OR ${subscriptionEntitlementGrants.endsAt} > ${now})`,
      )).limit(1),
      tx.select({ id: userSubscriptions.id }).from(userSubscriptions).where(and(
        eq(userSubscriptions.userId, userId),
        sql`((${userSubscriptions.status} IN ('active','authenticated','cancelled') AND (${userSubscriptions.currentPeriodEnd} IS NULL OR ${userSubscriptions.currentPeriodEnd} > ${now})) OR (${userSubscriptions.status} IN ('pending','halted') AND ${userSubscriptions.graceEndsAt} > ${now}))`,
      )).limit(1),
    ]);
    if (activeGrant[0] || activeSubscription[0]) throw conflict("Active Pro users cannot redeem a coupon");
    const [coupon] = await tx.select().from(subscriptionCoupons).where(eq(subscriptionCoupons.codeHash, codeHash)).for("update").limit(1);
    if (!coupon || !coupon.enabled || coupon.validFrom > now || (coupon.expiresAt && coupon.expiresAt <= now)) throw badRequest("Coupon is invalid or expired");
    if (coupon.redemptionCount >= coupon.maxRedemptions) throw conflict("Coupon redemption limit has been reached");
    const [prior] = await tx.select({ id: subscriptionCouponRedemptions.id }).from(subscriptionCouponRedemptions).where(and(eq(subscriptionCouponRedemptions.couponId, coupon.id), eq(subscriptionCouponRedemptions.userId, userId))).limit(1);
    if (prior) throw conflict("Coupon has already been redeemed by this account");
    const expiresAt = addMonths(now, coupon.durationMonths);
    const [redemption] = await tx.insert(subscriptionCouponRedemptions).values({ couponId: coupon.id, userId, expiresAt }).returning();
    await tx.insert(subscriptionEntitlementGrants).values({ userId, source: "coupon", sourceId: redemption.id, startsAt: now, endsAt: expiresAt, reason: coupon.name });
    await tx.update(subscriptionCoupons).set({ redemptionCount: sql`${subscriptionCoupons.redemptionCount} + 1`, updatedAt: now }).where(eq(subscriptionCoupons.id, coupon.id));
    return { expiresAt };
  });
  await refreshUserPlan(userId);
  return { ...result, plan: "pro" as const };
}

export async function applyProviderSubscription(provider: RazorpaySubscription, knownUserId?: string) {
  const existing = await db.select().from(userSubscriptions).where(eq(userSubscriptions.providerSubscriptionId, provider.id)).limit(1);
  if (!existing[0]) {
    logger.warn({ providerSubscriptionId: provider.id }, "Ignored unknown Razorpay subscription webhook");
    return null;
  }
  const userId = knownUserId ?? existing[0].userId;
  const now = new Date();
  const providerStatus = provider.status || existing[0].status;
  const graceEndsAt = ["pending", "halted"].includes(providerStatus)
    ? existing[0].graceEndsAt ?? new Date(now.getTime() + SUBSCRIPTION_GRACE_MS)
    : null;
  const nextPlan = provider.plan_id
    ? await db.select({ code: subscriptionPlans.code }).from(subscriptionPlans).where(eq(subscriptionPlans.razorpayPlanId, provider.plan_id)).limit(1)
    : [];
  await db.update(userSubscriptions).set({
    status: providerStatus,
    ...(nextPlan[0] ? { planCode: nextPlan[0].code, pendingPlanCode: null } : {}),
    currentPeriodStart: fromUnix(provider.current_start) ?? existing[0].currentPeriodStart,
    currentPeriodEnd: fromUnix(provider.current_end) ?? existing[0].currentPeriodEnd,
    graceEndsAt,
    endedAt: fromUnix(provider.ended_at) ?? existing[0].endedAt,
    providerPayload: provider as unknown as Record<string, unknown>,
    updatedAt: now,
  }).where(eq(userSubscriptions.id, existing[0].id));
  await refreshUserPlan(userId, now);
  return existing[0].id;
}

export async function reconcileSubscription(id: string) {
  const [row] = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
  if (!row) throw notFound("Subscription not found");
  const provider = await fetchRazorpaySubscription(row.providerSubscriptionId);
  await applyProviderSubscription(provider, row.userId);
  return getBillingOverview(row.userId);
}

export async function listAdminSubscriptions(input: { status?: string; search?: string; page: number; pageSize: number }) {
  const where = and(
    input.status ? eq(userSubscriptions.status, input.status) : undefined,
    input.search ? or(ilike(users.email, `%${input.search}%`), ilike(users.name, `%${input.search}%`), ilike(userSubscriptions.providerSubscriptionId, `%${input.search}%`)) : undefined,
  );
  const rows = await db.select({ subscription: userSubscriptions, plan: subscriptionPlans, user: { id: users.id, name: users.name, email: users.email, plan: users.plan } })
    .from(userSubscriptions).innerJoin(users, eq(userSubscriptions.userId, users.id)).innerJoin(subscriptionPlans, eq(userSubscriptions.planCode, subscriptionPlans.code))
    .where(where).orderBy(desc(userSubscriptions.createdAt)).limit(input.pageSize).offset((input.page - 1) * input.pageSize);
  const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(userSubscriptions).innerJoin(users, eq(userSubscriptions.userId, users.id)).where(where);
  return { items: rows, total: count?.value ?? 0, page: input.page, pageSize: input.pageSize };
}

export async function listAdminCoupons() {
  return db.select().from(subscriptionCoupons).orderBy(desc(subscriptionCoupons.createdAt));
}

export async function listAdminGrants() {
  return db.select({ grant: subscriptionEntitlementGrants, user: { id: users.id, email: users.email, name: users.name } })
    .from(subscriptionEntitlementGrants)
    .innerJoin(users, eq(subscriptionEntitlementGrants.userId, users.id))
    .orderBy(desc(subscriptionEntitlementGrants.createdAt))
    .limit(200);
}

export async function createAdminCoupon(input: { actorUserId: string; name: string; durationMonths: number; maxRedemptions: number; expiresAt?: string | null }) {
  const code = generateCouponCode();
  const [coupon] = await db.insert(subscriptionCoupons).values({
    name: input.name,
    codeHash: hashCoupon(code),
    codePrefix: code.slice(0, 10),
    durationMonths: input.durationMonths,
    maxRedemptions: input.maxRedemptions,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    createdByUserId: input.actorUserId,
  }).returning();
  return { coupon, code };
}

export async function disableAdminCoupon(id: string) {
  const [coupon] = await db.update(subscriptionCoupons).set({ enabled: false, updatedAt: new Date() }).where(eq(subscriptionCoupons.id, id)).returning();
  if (!coupon) throw notFound("Coupon not found");
  return coupon;
}

export async function createAdminGrant(input: { actorUserId: string; userId: string; durationMonths: number | null; reason: string }) {
  const now = new Date();
  const [grant] = await db.insert(subscriptionEntitlementGrants).values({
    userId: input.userId,
    source: "manual",
    reason: input.reason,
    startsAt: now,
    endsAt: input.durationMonths ? addMonths(now, input.durationMonths) : null,
    createdByUserId: input.actorUserId,
  }).returning();
  await refreshUserPlan(input.userId, now);
  return grant;
}

export async function revokeAdminGrant(id: string) {
  const [grant] = await db.update(subscriptionEntitlementGrants).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(subscriptionEntitlementGrants.id, id)).returning();
  if (!grant) throw notFound("Entitlement grant not found");
  await refreshUserPlan(grant.userId);
  return grant;
}

export async function listAdminPayments() {
  return db.select({ payment: subscriptionPayments, user: { id: users.id, email: users.email, name: users.name } }).from(subscriptionPayments).innerJoin(users, eq(subscriptionPayments.userId, users.id)).orderBy(desc(subscriptionPayments.createdAt)).limit(200);
}

export async function listAdminWebhookEvents() {
  return db.select({
    id: subscriptionWebhookEvents.id,
    providerEventId: subscriptionWebhookEvents.providerEventId,
    eventType: subscriptionWebhookEvents.eventType,
    status: subscriptionWebhookEvents.status,
    errorMessage: subscriptionWebhookEvents.errorMessage,
    processedAt: subscriptionWebhookEvents.processedAt,
    createdAt: subscriptionWebhookEvents.createdAt,
  }).from(subscriptionWebhookEvents).orderBy(desc(subscriptionWebhookEvents.createdAt)).limit(200);
}
