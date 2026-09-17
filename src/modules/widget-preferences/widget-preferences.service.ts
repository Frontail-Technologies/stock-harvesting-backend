import type { WidgetPreferenceSource } from "../../db/schema";
import {
  deleteWidgetPreferencesRow,
  findWidgetPreferencesRow,
  upsertWidgetPreferencesRow,
} from "./widget-preferences.repository";

export type WidgetPreferencesResult =
  | { hasSavedPreference: true; sources: WidgetPreferenceSource[] }
  | { hasSavedPreference: false; sources: [] };

export async function getWidgetPreferences(
  userId: string,
): Promise<WidgetPreferencesResult> {
  const row = await findWidgetPreferencesRow(userId);

  if (!row) return { hasSavedPreference: false, sources: [] };
  return { hasSavedPreference: true, sources: row.sources };
}

export async function saveWidgetPreferences(
  userId: string,
  sources: WidgetPreferenceSource[],
): Promise<{ sources: WidgetPreferenceSource[] }> {
  return upsertWidgetPreferencesRow(userId, sources);
}

export async function clearWidgetPreferences(
  userId: string,
): Promise<{ ok: true }> {
  await deleteWidgetPreferencesRow(userId);
  return { ok: true };
}
