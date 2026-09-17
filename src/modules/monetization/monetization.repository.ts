import { eq, inArray } from "drizzle-orm";

import { db } from "../../db/client";
import { adPlacements, monetizationSettings } from "../../db/schema";
import {
  AD_PLACEMENTS,
  AD_PLACEMENT_KEYS,
  MONETIZATION_SETTINGS_DEFAULTS,
  type AdPlacementKey,
  type MonetizationMode,
} from "../../shared/constants";

export async function ensurePlacementsSeeded() {
  await db
    .insert(adPlacements)
    .values(AD_PLACEMENTS.map((placement) => ({ key: placement.key })))
    .onConflictDoNothing();
}

export async function findMonetizationSettingsRow() {
  const [settings] = await db
    .select()
    .from(monetizationSettings)
    .where(eq(monetizationSettings.id, MONETIZATION_SETTINGS_DEFAULTS.id));
  return settings;
}

export async function createDefaultMonetizationSettingsRow() {
  const [created] = await db
    .insert(monetizationSettings)
    .values({ id: MONETIZATION_SETTINGS_DEFAULTS.id })
    .onConflictDoNothing()
    .returning();
  return created;
}

export async function findAdPlacementRows() {
  return db.select().from(adPlacements).where(inArray(adPlacements.key, AD_PLACEMENT_KEYS));
}

export async function upsertMonetizationSettingsRow(input: {
  mode: MonetizationMode;
  publisherId: string | null;
}) {
  const [settings] = await db
    .insert(monetizationSettings)
    .values({
      id: MONETIZATION_SETTINGS_DEFAULTS.id,
      mode: input.mode,
      publisherId: input.publisherId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: monetizationSettings.id,
      set: {
        mode: input.mode,
        publisherId: input.publisherId,
        updatedAt: new Date(),
      },
    })
    .returning();

  return settings;
}

export async function updateAdPlacementRow(input: {
  key: AdPlacementKey;
  enabled: boolean;
  slotId: string | null;
}) {
  const [placement] = await db
    .update(adPlacements)
    .set({
      enabled: input.enabled,
      slotId: input.slotId,
      updatedAt: new Date(),
    })
    .where(eq(adPlacements.key, input.key))
    .returning();

  return placement;
}
