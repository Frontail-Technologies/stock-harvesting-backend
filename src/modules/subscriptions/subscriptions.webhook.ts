import { createHmac, timingSafeEqual, createHash } from "crypto";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { subscriptionPayments, subscriptionWebhookEvents, userSubscriptions } from "../../db/schema";
import { env } from "../../shared/env";
import { logger } from "../../shared/logger";
import { applyProviderSubscription } from "./subscriptions.service";
import type { RazorpaySubscription } from "./razorpay.client";

type WebhookPayload = {
  event?: string;
  payload?: {
    subscription?: { entity?: RazorpaySubscription };
    payment?: { entity?: Record<string, unknown> };
  };
};

export function verifyRazorpayWebhook(rawBody: Buffer, signature: string, secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function unixDate(value: unknown) {
  return typeof value === "number" && value > 0 ? new Date(value * 1000) : null;
}

async function persistPayment(entity: Record<string, unknown>) {
  const providerSubscriptionId = typeof entity.subscription_id === "string" ? entity.subscription_id : null;
  const providerPaymentId = typeof entity.id === "string" ? entity.id : null;
  if (!providerSubscriptionId || !providerPaymentId) return;
  const [subscription] = await db.select().from(userSubscriptions).where(eq(userSubscriptions.providerSubscriptionId, providerSubscriptionId)).limit(1);
  if (!subscription) return;
  await db.insert(subscriptionPayments).values({
    subscriptionId: subscription.id,
    userId: subscription.userId,
    providerPaymentId,
    providerInvoiceId: typeof entity.invoice_id === "string" ? entity.invoice_id : null,
    amountPaise: typeof entity.amount === "number" ? entity.amount : 0,
    currency: typeof entity.currency === "string" ? entity.currency : "INR",
    status: typeof entity.status === "string" ? entity.status : "unknown",
    paidAt: unixDate(entity.captured_at) ?? unixDate(entity.created_at),
    providerPayload: entity,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: subscriptionPayments.providerPaymentId,
    set: {
      status: typeof entity.status === "string" ? entity.status : "unknown",
      paidAt: unixDate(entity.captured_at) ?? unixDate(entity.created_at),
      providerPayload: entity,
      updatedAt: new Date(),
    },
  });
}

async function processEvent(payload: WebhookPayload) {
  const subscription = payload.payload?.subscription?.entity;
  if (subscription?.id) await applyProviderSubscription(subscription);
  const payment = payload.payload?.payment?.entity;
  if (payment) await persistPayment(payment);
}

export async function razorpayWebhookHandler(req: Request, res: Response) {
  const rawBody = req.body;
  const signature = req.get("x-razorpay-signature") ?? "";
  if (!Buffer.isBuffer(rawBody) || !env.RAZORPAY_WEBHOOK_SECRET || !verifyRazorpayWebhook(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid webhook signature" } });
  }
  const payload = JSON.parse(rawBody.toString("utf8")) as WebhookPayload;
  const providerEventId = req.get("x-razorpay-event-id")
    ?? createHash("sha256").update(rawBody).digest("hex");
  const inserted = await db.insert(subscriptionWebhookEvents).values({
    providerEventId,
    eventType: payload.event ?? "unknown",
    payload: payload as unknown as Record<string, unknown>,
  }).onConflictDoNothing().returning({ id: subscriptionWebhookEvents.id });
  let eventId = inserted[0]?.id;
  if (!eventId) {
    const [existing] = await db.select({ id: subscriptionWebhookEvents.id, status: subscriptionWebhookEvents.status })
      .from(subscriptionWebhookEvents).where(eq(subscriptionWebhookEvents.providerEventId, providerEventId)).limit(1);
    if (!existing || existing.status !== "failed") return res.status(200).json({ received: true, duplicate: true });
    eventId = existing.id;
    await db.update(subscriptionWebhookEvents).set({ status: "received", errorMessage: null }).where(eq(subscriptionWebhookEvents.id, eventId));
  }
  try {
    await processEvent(payload);
    await db.update(subscriptionWebhookEvents).set({ status: "processed", processedAt: new Date() }).where(eq(subscriptionWebhookEvents.id, eventId));
    return res.status(200).json({ received: true });
  } catch (error) {
    logger.error({ err: error, providerEventId, eventType: payload.event }, "Razorpay webhook processing failed");
    await db.update(subscriptionWebhookEvents).set({ status: "failed", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error" }).where(eq(subscriptionWebhookEvents.id, eventId));
    return res.status(500).json({ received: false });
  }
}
