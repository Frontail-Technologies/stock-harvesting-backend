import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { subscriptionEntitlementGrants, userSubscriptions, users } from "../../db/schema";
import { USER_PLAN } from "../../shared/constants";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./subscriptions.constants";

export async function hasEffectivePro(userId: string, now = new Date()) {
  const [grant, subscription] = await Promise.all([
    db.select({ id: subscriptionEntitlementGrants.id }).from(subscriptionEntitlementGrants).where(and(
      eq(subscriptionEntitlementGrants.userId, userId),
      isNull(subscriptionEntitlementGrants.revokedAt),
      lte(subscriptionEntitlementGrants.startsAt, now),
      or(isNull(subscriptionEntitlementGrants.endsAt), gt(subscriptionEntitlementGrants.endsAt, now)),
    )).limit(1),
    db.select({ id: userSubscriptions.id }).from(userSubscriptions).where(and(
      eq(userSubscriptions.userId, userId),
      or(
        and(
          inArray(userSubscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
          or(isNull(userSubscriptions.currentPeriodEnd), gt(userSubscriptions.currentPeriodEnd, now)),
        ),
        and(
          inArray(userSubscriptions.status, ["pending", "halted"]),
          gt(userSubscriptions.graceEndsAt, now),
        ),
      ),
    )).limit(1),
  ]);
  return grant.length > 0 || subscription.length > 0;
}

export async function refreshUserPlan(userId: string, now = new Date()) {
  const plan = await hasEffectivePro(userId, now) ? USER_PLAN.pro : USER_PLAN.free;
  await db.update(users).set({ plan, updatedAt: now }).where(eq(users.id, userId));
  return plan;
}

export async function reconcileAllEntitlements(now = new Date()) {
  const result = await db.execute(sql`
    WITH effective AS (
      SELECT u.id, CASE WHEN
      EXISTS (
        SELECT 1 FROM subscription_entitlement_grants g
        WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.starts_at <= ${now}
          AND (g.ends_at IS NULL OR g.ends_at > ${now})
      ) OR EXISTS (
        SELECT 1 FROM user_subscriptions s
        WHERE s.user_id = u.id AND (
          (s.status IN ('active', 'authenticated', 'cancelled') AND (s.current_period_end IS NULL OR s.current_period_end > ${now}))
          OR (s.status IN ('pending', 'halted') AND s.grace_ends_at > ${now})
        )
      ) THEN 'pro'::user_plan ELSE 'free'::user_plan END AS plan
      FROM users u WHERE u.role = 'user'
    )
    UPDATE users u SET plan = effective.plan, updated_at = ${now}
    FROM effective
    WHERE u.id = effective.id AND u.plan IS DISTINCT FROM effective.plan
  `);
  return { updated: result.rowCount ?? 0 };
}
