import type { Request, Response } from "express";

import { sendData } from "../../shared/http";
import { getAuthUserId } from "../../shared/middleware";
import { deletePushSubscription, getPushPublicKey, upsertPushSubscription } from "./push-subscriptions.service";

export async function getPushPublicKeyController(_req: Request, res: Response) {
  sendData(res, getPushPublicKey());
}

export async function upsertPushSubscriptionController(req: Request, res: Response) {
  const body = req.body as {
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
  };
  const userAgentHeader = req.headers["user-agent"];
  const subscription = await upsertPushSubscription({
    userId: getAuthUserId(req),
    subscription: body.subscription,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(" ") : userAgentHeader,
  });
  sendData(res, { subscription });
}

export async function deletePushSubscriptionController(req: Request, res: Response) {
  const body = req.body as { endpoint: string };
  sendData(res, await deletePushSubscription({ userId: getAuthUserId(req), endpoint: body.endpoint }));
}
