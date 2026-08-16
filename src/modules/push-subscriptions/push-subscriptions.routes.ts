import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import {
  deletePushSubscriptionBodySchema,
  upsertPushSubscriptionBodySchema,
} from "./push-subscriptions.schemas";
import {
  deletePushSubscription,
  getPushPublicKey,
  upsertPushSubscription,
} from "./push-subscriptions.service";

export const pushSubscriptionsRouter = Router();

pushSubscriptionsRouter.get(
  "/public-key",
  asyncHandler(async (_req, res) => {
    sendData(res, getPushPublicKey());
  })
);

pushSubscriptionsRouter.use(requireAuth);

pushSubscriptionsRouter.post(
  "/",
  validate({ body: upsertPushSubscriptionBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      subscription: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
    };
    const subscription = await upsertPushSubscription({
      userId: getAuthUserId(req),
      subscription: body.subscription,
      userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"].join(" ") : req.headers["user-agent"],
    });
    sendData(res, { subscription });
  })
);

pushSubscriptionsRouter.delete(
  "/",
  validate({ body: deletePushSubscriptionBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { endpoint: string };
    sendData(res, await deletePushSubscription({ userId: getAuthUserId(req), endpoint: body.endpoint }));
  })
);
