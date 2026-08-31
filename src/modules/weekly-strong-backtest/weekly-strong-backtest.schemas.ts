import { z } from "zod";

export const collectionCodeParamsSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
  })
  .strict();

export const collectionCodeWeekParamsSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    weekEnding: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "weekEnding must be YYYY-MM-DD"),
  })
  .strict();

export const collectionIdParamsSchema = z
  .object({
    id: z.string().trim().uuid(),
  })
  .strict();

export const backfillBodySchema = z
  .object({
    weeks: z.coerce.number().int().positive().max(260).optional(),
  })
  .strict();
