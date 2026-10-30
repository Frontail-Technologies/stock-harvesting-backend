import { z } from "zod";

import { SUBSCRIPTION_CATALOG } from "./subscriptions.constants";

const planCodes = SUBSCRIPTION_CATALOG.map((plan) => plan.code) as [string, ...string[]];

export const createCheckoutSchema = z.object({ planCode: z.enum(planCodes) });
export const changePlanSchema = z.object({ planCode: z.enum(planCodes) });
export const redeemCouponSchema = z.object({ code: z.string().trim().min(6).max(80) });
export const subscriptionIdSchema = z.object({ id: z.uuid() });
export const adminSubscriptionQuerySchema = z.object({
  status: z.string().trim().max(32).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const createCouponSchema = z.object({
  name: z.string().trim().min(2).max(120),
  durationMonths: z.number().int().min(1).max(36),
  maxRedemptions: z.number().int().min(1).max(100_000),
  expiresAt: z.iso.datetime().nullable().optional(),
});
export const createGrantSchema = z.object({
  userId: z.uuid(),
  durationMonths: z.number().int().min(1).max(120).nullable(),
  reason: z.string().trim().min(2).max(500),
});
export const grantIdSchema = z.object({ id: z.uuid() });
