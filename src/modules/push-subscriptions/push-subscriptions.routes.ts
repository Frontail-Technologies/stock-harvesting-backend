import { Router } from "express";

import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  deletePushSubscriptionController,
  getPushPublicKeyController,
  upsertPushSubscriptionController,
} from "./push-subscriptions.controller";
import {
  deletePushSubscriptionBodySchema,
  upsertPushSubscriptionBodySchema,
} from "./push-subscriptions.schemas";

export const pushSubscriptionsRouter = Router();

pushSubscriptionsRouter.get("/public-key", asyncHandler(getPushPublicKeyController));

pushSubscriptionsRouter.use(requireAuth);

pushSubscriptionsRouter.post(
  "/",
  validate({ body: upsertPushSubscriptionBodySchema }),
  asyncHandler(upsertPushSubscriptionController)
);

pushSubscriptionsRouter.delete(
  "/",
  validate({ body: deletePushSubscriptionBodySchema }),
  asyncHandler(deletePushSubscriptionController)
);
