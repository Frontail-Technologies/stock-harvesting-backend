import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { widgetPreferences, type WidgetPreferenceSource } from "../../db/schema";

export async function findWidgetPreferencesRow(
  userId: string
): Promise<{ sources: WidgetPreferenceSource[] } | undefined> {
  const [row] = await db
    .select({ sources: widgetPreferences.sources })
    .from(widgetPreferences)
    .where(eq(widgetPreferences.userId, userId))
    .limit(1);

  return row;
}

export async function upsertWidgetPreferencesRow(
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

  return row;
}

export async function deleteWidgetPreferencesRow(userId: string): Promise<void> {
  await db.delete(widgetPreferences).where(eq(widgetPreferences.userId, userId));
}
