import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAdmin, requireAdminAuth, requireAuth, validate } from "../../shared/middleware";
import {
  adminSubscriptionQuerySchema,
  changePlanSchema,
  createCheckoutSchema,
  createCouponSchema,
  createGrantSchema,
  grantIdSchema,
  redeemCouponSchema,
  subscriptionIdSchema,
} from "./subscriptions.schemas";
import {
  cancelUserSubscription,
  changeUserSubscriptionPlan,
  createAdminCoupon,
  createAdminGrant,
  createCheckout,
  disableAdminCoupon,
  getBillingOverview,
  listAdminCoupons,
  listAdminPayments,
  listAdminGrants,
  listAdminSubscriptions,
  listAdminWebhookEvents,
  listPublicPlans,
  reconcileSubscription,
  redeemCoupon,
  revokeAdminGrant,
} from "./subscriptions.service";

export const subscriptionsRouter = Router();

subscriptionsRouter.get("/plans", asyncHandler(async (_req, res) => sendData(res, { plans: await listPublicPlans() })));

subscriptionsRouter.use("/me", requireAuth);
subscriptionsRouter.get("/me", asyncHandler(async (req, res) => sendData(res, await getBillingOverview(getAuthUserId(req)))));
subscriptionsRouter.post("/me/checkout", validate({ body: createCheckoutSchema }), asyncHandler(async (req, res) => {
  sendData(res, await createCheckout(getAuthUserId(req), (req.body as { planCode: string }).planCode));
}));
subscriptionsRouter.post("/me/redeem", validate({ body: redeemCouponSchema }), asyncHandler(async (req, res) => {
  sendData(res, await redeemCoupon(getAuthUserId(req), (req.body as { code: string }).code));
}));
subscriptionsRouter.post("/me/:id/cancel", validate({ params: subscriptionIdSchema }), asyncHandler(async (req, res) => {
  sendData(res, await cancelUserSubscription(getAuthUserId(req), (req.params as { id: string }).id));
}));
subscriptionsRouter.post("/me/:id/change-plan", validate({ params: subscriptionIdSchema, body: changePlanSchema }), asyncHandler(async (req, res) => {
  sendData(res, await changeUserSubscriptionPlan(getAuthUserId(req), (req.params as { id: string }).id, (req.body as { planCode: string }).planCode));
}));

subscriptionsRouter.use("/admin", requireAdminAuth, requireAdmin);
subscriptionsRouter.get("/admin", validate({ query: adminSubscriptionQuerySchema }), asyncHandler(async (req, res) => {
  sendData(res, await listAdminSubscriptions(req.query as unknown as Parameters<typeof listAdminSubscriptions>[0]));
}));
subscriptionsRouter.get("/admin/payments", asyncHandler(async (_req, res) => sendData(res, { items: await listAdminPayments() })));
subscriptionsRouter.get("/admin/events", asyncHandler(async (_req, res) => sendData(res, { items: await listAdminWebhookEvents() })));
subscriptionsRouter.get("/admin/coupons", asyncHandler(async (_req, res) => sendData(res, { items: await listAdminCoupons() })));
subscriptionsRouter.get("/admin/grants", asyncHandler(async (_req, res) => sendData(res, { items: await listAdminGrants() })));
subscriptionsRouter.post("/admin/coupons", validate({ body: createCouponSchema }), asyncHandler(async (req, res) => {
  sendData(res, await createAdminCoupon({ actorUserId: getAuthUserId(req), ...(req.body as { name: string; durationMonths: number; maxRedemptions: number; expiresAt?: string | null }) }));
}));
subscriptionsRouter.post("/admin/coupons/:id/disable", validate({ params: grantIdSchema }), asyncHandler(async (req, res) => sendData(res, { coupon: await disableAdminCoupon((req.params as { id: string }).id) })));
subscriptionsRouter.post("/admin/grants", validate({ body: createGrantSchema }), asyncHandler(async (req, res) => {
  sendData(res, { grant: await createAdminGrant({ actorUserId: getAuthUserId(req), ...(req.body as { userId: string; durationMonths: number | null; reason: string }) }) });
}));
subscriptionsRouter.post("/admin/grants/:id/revoke", validate({ params: grantIdSchema }), asyncHandler(async (req, res) => sendData(res, { grant: await revokeAdminGrant((req.params as { id: string }).id) })));
subscriptionsRouter.post("/admin/:id/reconcile", validate({ params: subscriptionIdSchema }), asyncHandler(async (req, res) => sendData(res, await reconcileSubscription((req.params as { id: string }).id))));
subscriptionsRouter.post("/admin/:id/cancel", validate({ params: subscriptionIdSchema }), asyncHandler(async (req, res) => {
  const id = (req.params as { id: string }).id;
  const overview = await reconcileSubscription(id);
  const subscription = overview.subscription?.subscription;
  if (!subscription) return sendData(res, overview);
  sendData(res, await cancelUserSubscription(subscription.userId, subscription.id));
}));
