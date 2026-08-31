import { z } from "zod";

export const googleAuthUrlQuerySchema = z
  .object({
    portal: z.enum(["admin"]).optional(),
  })
  .strict();

export const googleCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .passthrough();
