import { z } from "zod";

// Deliberately permissive on count (no .max) - the Widget page itself is
// the UX gate on how many sources make sense to add; the persistence layer
// shouldn't encode a proprietary limit.
export const saveWidgetPreferencesBodySchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            type: z.enum(["segment", "watchlist"]),
            id: z.string().uuid(),
          })
          .strict()
      )
      .max(100),
  })
  .strict();
