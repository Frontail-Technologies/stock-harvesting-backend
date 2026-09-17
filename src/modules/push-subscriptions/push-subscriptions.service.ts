import webPush from "web-push";

import { pushSubscriptions } from "../../db/schema";
import { env } from "../../shared/env";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import type { PriceAlertCondition } from "../price-alerts/price-alerts.types";
import {
  deletePushSubscriptionById,
  deletePushSubscriptionRow,
  findPushSubscriptionByEndpoint,
  findPushSubscriptionsByUser,
  insertPushSubscription,
  updatePushSubscription,
} from "./push-subscriptions.repository";

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
  const existing = await findPushSubscriptionByEndpoint(input.subscription.endpoint);

  if (existing) {
    const row = await updatePushSubscription({
      id: existing.id,
      userId: input.userId,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      userAgent: input.userAgent,
    });
    return toPushSubscriptionResponse(row);
  }

  const row = await insertPushSubscription({
    userId: input.userId,
    endpoint: input.subscription.endpoint,
    p256dh: input.subscription.keys.p256dh,
    auth: input.subscription.keys.auth,
    userAgent: input.userAgent,
  });
  return toPushSubscriptionResponse(row);
}

export async function deletePushSubscription(input: { userId: string; endpoint: string }) {
  await deletePushSubscriptionRow(input);
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

  const rows = await findPushSubscriptionsByUser(input.userId);

  const title = `${input.symbol} price alert triggered`;
  const body = `${input.symbol} is ${input.condition.toLowerCase()} ${input.targetPrice}. Current price: ${input.price}.`;
  const payload = JSON.stringify({
    title,
    body,
    url: `/charts?symbol=${encodeURIComponent(input.symbol)}&exchange=${encodeURIComponent(input.exchange)}`,
    tag: `price-alert:${input.exchange}:${input.symbol}`,
  });

  // Fanned out with allSettled, not a sequential loop: bounded by one user's device count, each send is fully independent, and per-row error handling already tolerates any one send failing - no ordering or shared-state reason to run one at a time.
  await Promise.allSettled(
    rows.map(async (row) => {
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
          await deletePushSubscriptionById(row.id);
          return;
        }
        logger.warn(
          { subscriptionId: row.id, message: getErrorMessage(error, "Unknown push error") },
          "Push notification send failed"
        );
      }
    })
  );
}

function toPushSubscriptionResponse(row: typeof pushSubscriptions.$inferSelect) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
