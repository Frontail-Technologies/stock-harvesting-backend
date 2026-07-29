import { z } from "zod";

export const googleCallbackQuerySchema = z
  .object({
    code: z.string().min(1),
    state: z.string().min(1),
  })
  .passthrough();
