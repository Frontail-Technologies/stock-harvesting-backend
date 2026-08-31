import { and, eq } from "drizzle-orm";
import webPush from "web-push";

import { db } from "../../db/client";
import { pushSubscriptions } from "../../db/schema";
import { env } from "../../shared/env";
import { logger } from "../../shared/logger";
import type { PriceAlertCondition } from "../price-alerts/price-alerts.service";

type PushSubscriptionInput = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

function pushConfigured() {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function configureWebPush() {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webPush.setVapidDetails(env.VAPID_SUBJECT, publicKey, privateKey);
  return true;
}

export function getPushPublicKey() {
  return {
    publicKey: env.VAPID_PUBLIC_KEY ?? null,
    configured: pushConfigured(),
  };
}

export async function upsertPushSubscription(input: {
  userId: string;
  subscription: PushSubscriptionInput;
  userAgent?: string;
}) {
  const [existing] = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, input.subscription.endpoint))
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(pushSubscriptions)
      .set({
        userId: input.userId,
        p256dh: input.subscription.keys.p256dh,
        auth: input.subscription.keys.auth,
        userAgent: input.userAgent,
        updatedAt: new Date(),
      })
      .where(eq(pushSubscriptions.id, existing.id))
      .returning();
    return toPushSubscriptionResponse(row);
  }

  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId: input.userId,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      userAgent: input.userAgent,
    })
    .returning();
  return toPushSubscriptionResponse(row);
}

export async function deletePushSubscription(input: { userId: string; endpoint: string }) {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, input.userId), eq(pushSubscriptions.endpoint, input.endpoint)));
  return { ok: true };
}

export async function sendPriceAlertNotification(input: {
  userId: string;
  exchange: string;
  symbol: string;
  condition: PriceAlertCondition;
  targetPrice: number;
  price: number;
}) {
  if (!configureWebPush()) {
    logger.warn("Push notifications skipped because VAPID is not configured");
    return;
  }

  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId));

  const title = `${input.symbol} price alert triggered`;
  const body = `${input.symbol} is ${input.condition.toLowerCase()} ${input.targetPrice}. Current price: ${input.price}.`;
  const payload = JSON.stringify({
    title,
    body,
    url: `/charts?symbol=${encodeURIComponent(input.symbol)}&exchange=${encodeURIComponent(input.exchange)}`,
    tag: `price-alert:${input.exchange}:${input.symbol}`,
  });

  for (const row of rows) {
    try {
      await webPush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        },
        payload
      );
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : null;
      if (statusCode === 404 || statusCode === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
        continue;
      }
      logger.warn(
        { subscriptionId: row.id, message: error instanceof Error ? error.message : "Unknown push error" },
        "Push notification send failed"
      );
    }
  }
}

function toPushSubscriptionResponse(row: typeof pushSubscriptions.$inferSelect) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
