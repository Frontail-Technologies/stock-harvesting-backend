import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { pushSubscriptions } from "../../db/schema";

export async function findPushSubscriptionByEndpoint(endpoint: string) {
  const [row] = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .limit(1);

  return row;
}

export async function updatePushSubscription(input: {
  id: string;
  userId: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}) {
  const [row] = await db
    .update(pushSubscriptions)
    .set({
      userId: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
      updatedAt: new Date(),
    })
    .where(eq(pushSubscriptions.id, input.id))
    .returning();

  return row;
}

export async function insertPushSubscription(input: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}) {
  const [row] = await db.insert(pushSubscriptions).values(input).returning();
  return row;
}

export async function deletePushSubscriptionRow(input: { userId: string; endpoint: string }) {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, input.userId), eq(pushSubscriptions.endpoint, input.endpoint)));
}

export async function findPushSubscriptionsByUser(userId: string) {
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}

export async function deletePushSubscriptionById(id: string) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}
