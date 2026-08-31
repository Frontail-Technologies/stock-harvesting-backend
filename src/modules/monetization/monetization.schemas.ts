import { z } from "zod";

import { AD_PLACEMENT_KEYS, MONETIZATION_MODES, type AdPlacementKey } from "../../shared/constants";
import { isValidPublisherId, isValidSlotId } from "./monetization.service";

// Empty string means "clear the value" (transforms to null) rather than a
// format error - only a non-empty, malformed value is rejected. This lets a
// PUT body always carry both fields (full-replace semantics, matching the
// branding/ai-settings convention) even when clearing a previously-set id.
const publisherIdSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => value.length === 0 || isValidPublisherId(value), {
    message: "Publisher ID must look like ca-pub-XXXXXXXXXXXXXXX",
  })
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

const slotIdSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => value.length === 0 || isValidSlotId(value), {
    message: "Slot ID must be a numeric AdSense slot ID",
  })
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

export const updateMonetizationSettingsBodySchema = z
  .object({
    mode: z.enum(MONETIZATION_MODES),
    publisherId: publisherIdSchema,
  })
  .strict();

export const updateAdPlacementBodySchema = z
  .object({
    enabled: z.boolean(),
    slotId: slotIdSchema,
  })
  .strict();

export const adPlacementKeyParamsSchema = z
  .object({
    key: z.enum(AD_PLACEMENT_KEYS as [AdPlacementKey, ...AdPlacementKey[]]),
  })
  .strict();
