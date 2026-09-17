import { z } from "zod";

export const saveWidgetPreferencesBodySchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            type: z.enum(["segment", "watchlist"]),
            id: z.string().uuid(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
