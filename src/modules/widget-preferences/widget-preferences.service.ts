import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { widgetPreferences, type WidgetPreferenceSource } from "../../db/schema";

export type WidgetPreferencesResult =
  | { hasSavedPreference: true; sources: WidgetPreferenceSource[] }
  | { hasSavedPreference: false; sources: [] };

// Row absence means "never saved a preference" (defaults should apply);
// row presence with sources: [] means "the user deliberately cleared their
// selection" - these are NOT the same state, and callers must not collapse
// them.
export async function getWidgetPreferences(userId: string): Promise<WidgetPreferencesResult> {
  const [row] = await db
    .select({ sources: widgetPreferences.sources })
    .from(widgetPreferences)
    .where(eq(widgetPreferences.userId, userId))
    .limit(1);

  if (!row) return { hasSavedPreference: false, sources: [] };
  return { hasSavedPreference: true, sources: row.sources };
}

export async function saveWidgetPreferences(
  userId: string,
  sources: WidgetPreferenceSource[]
): Promise<{ sources: WidgetPreferenceSource[] }> {
  const [row] = await db
    .insert(widgetPreferences)
    .values({ userId, sources })
    .onConflictDoUpdate({
      target: widgetPreferences.userId,
      set: { sources, updatedAt: new Date() },
    })
    .returning({ sources: widgetPreferences.sources });

  return { sources: row.sources };
}

// Reverts the user back to "no saved preference" - the Widget page then
// re-derives its source list from the current DB defaults again (rather
// than freezing at whatever the defaults were at reset time).
export async function clearWidgetPreferences(userId: string): Promise<{ ok: true }> {
  await db.delete(widgetPreferences).where(eq(widgetPreferences.userId, userId));
  return { ok: true };
}
