import { eq } from "drizzle-orm";

import { db, pool } from "../db/client";
import { subscriptionPlans } from "../db/schema";
import { createRazorpayPlan } from "../modules/subscriptions/razorpay.client";
import { ensureSubscriptionCatalog } from "../modules/subscriptions/subscriptions.service";
import { SUBSCRIPTION_CATALOG } from "../modules/subscriptions/subscriptions.constants";
import { env } from "../shared/env";

async function main() {
  await ensureSubscriptionCatalog();
  for (const catalog of SUBSCRIPTION_CATALOG) {
    const [stored] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.code, catalog.code)).limit(1);
    if (stored?.razorpayPlanId && stored.razorpayMode === env.RAZORPAY_MODE) {
      console.log(`${catalog.code}: ${stored.razorpayPlanId} (existing)`);
      continue;
    }
    const provider = await createRazorpayPlan(catalog);
    await db.update(subscriptionPlans).set({ razorpayPlanId: provider.id, razorpayMode: env.RAZORPAY_MODE, updatedAt: new Date() }).where(eq(subscriptionPlans.code, catalog.code));
    console.log(`${catalog.code}: ${provider.id} (created)`);
  }
}

main().finally(() => pool.end());
