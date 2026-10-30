import { env } from "../../shared/env";
import { logger } from "../../shared/logger";
import { reconcileAllEntitlements } from "./entitlements.service";

export function startSubscriptionReconciliation() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileAllEntitlements();
      logger.debug(result, "Subscription entitlements reconciled");
    } catch (error) {
      logger.error({ err: error }, "Subscription entitlement reconciliation failed");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), env.SUBSCRIPTION_RECONCILIATION_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
