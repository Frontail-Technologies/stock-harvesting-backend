import { z } from "zod";

const pushKeysSchema = z
  .object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1),
  })
  .strict();

const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().url(),
    expirationTime: z.number().nullable().optional(),
    keys: pushKeysSchema,
  })
  .strict();

export const upsertPushSubscriptionBodySchema = z
  .object({
    subscription: pushSubscriptionSchema,
  })
  .strict();

export const deletePushSubscriptionBodySchema = z
  .object({
    endpoint: z.string().url(),
  })
  .strict();
