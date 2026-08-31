import { eq, inArray } from "drizzle-orm";

import { db } from "../../db/client";
import { adPlacements, auditLogs, monetizationSettings } from "../../db/schema";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import {
  AD_PLACEMENTS,
  AD_PLACEMENT_KEYS,
  MONETIZATION_MODE,
  MONETIZATION_SETTINGS_DEFAULTS,
  type AdPlacementKey,
  type MonetizationMode,
} from "../../shared/constants";

const PUBLIC_CONFIG_CACHE_KEY = "monetizationConfig:public";
const PUBLIC_CONFIG_CACHE_TTL_MS = 30_000;

const PUBLISHER_ID_PATTERN = /^ca-pub-\d{10,20}$/;
const SLOT_ID_PATTERN = /^\d{6,20}$/;

export function isValidPublisherId(value: string) {
  return PUBLISHER_ID_PATTERN.test(value);
}

export function isValidSlotId(value: string) {
  return SLOT_ID_PATTERN.test(value);
}

// Mirrors the frontend's canRenderAd (src/features/adsense/lib/can-render-ad.ts)
// exactly - kept as two small independent implementations since this is a
// backend/frontend boundary, not duplicated logic within one runtime. Used
// here only to decide what to report back in a placement's "ready" status,
// not to gate the public config response itself (that stays raw truth; the
// frontend is the one thing that must fail closed on render).
export function isPlacementRenderable(
  mode: MonetizationMode,
  publisherId: string | null,
  placement: { enabled: boolean; slotId: string | null }
) {
  if (mode === MONETIZATION_MODE.off) return false;
  if (mode === MONETIZATION_MODE.preview) return placement.enabled;
  return Boolean(publisherId && placement.enabled && placement.slotId);
}

async function ensurePlacementsSeeded() {
  await db
    .insert(adPlacements)
    .values(AD_PLACEMENTS.map((placement) => ({ key: placement.key })))
    .onConflictDoNothing();
}

export async function getMonetizationSettings() {
  const [settings] = await db
    .select()
    .from(monetizationSettings)
    .where(eq(monetizationSettings.id, MONETIZATION_SETTINGS_DEFAULTS.id));
  if (settings) return settings;

  const [created] = await db
    .insert(monetizationSettings)
    .values({ id: MONETIZATION_SETTINGS_DEFAULTS.id })
    .onConflictDoNothing()
    .returning();

  return created;
}

export async function listAdPlacements() {
  await ensurePlacementsSeeded();
  const rows = await db
    .select()
    .from(adPlacements)
    .where(inArray(adPlacements.key, AD_PLACEMENT_KEYS));

  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  // Always return in AD_PLACEMENTS' declared order, with display metadata
  // attached - the DB row only knows key/enabled/slotId/updatedAt.
  return AD_PLACEMENTS.map((placement) => {
    const row = rowsByKey.get(placement.key);
    return {
      key: placement.key,
      label: placement.label,
      description: placement.description,
      enabled: row?.enabled ?? false,
      slotId: row?.slotId ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function getAdminMonetizationConfig() {
  const [settings, placements] = await Promise.all([
    getMonetizationSettings(),
    listAdPlacements(),
  ]);

  return {
    mode: settings.mode,
    publisherId: settings.publisherId,
    placements: placements.map((placement) => ({
      ...placement,
      renderable: isPlacementRenderable(settings.mode, settings.publisherId, placement),
    })),
  };
}

export async function updateMonetizationSettings(input: {
  actorUserId: string;
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

  await audit(input.actorUserId, "monetization.settings.updated", "monetization", "settings", {
    mode: input.mode,
    hasPublisherId: Boolean(input.publisherId),
  });
  invalidateCacheByPrefix("monetizationConfig");

  return settings;
}

export async function updateAdPlacement(input: {
  actorUserId: string;
  key: AdPlacementKey;
  enabled: boolean;
  slotId: string | null;
}) {
  await ensurePlacementsSeeded();

  const [placement] = await db
    .update(adPlacements)
    .set({
      enabled: input.enabled,
      slotId: input.slotId,
      updatedAt: new Date(),
    })
    .where(eq(adPlacements.key, input.key))
    .returning();

  await audit(input.actorUserId, "monetization.placement.updated", "ad_placement", input.key, {
    enabled: input.enabled,
    hasSlotId: Boolean(input.slotId),
  });
  invalidateCacheByPrefix("monetizationConfig");

  return placement;
}

export type PublicMonetizationConfig = {
  mode: MonetizationMode;
  publisherId: string | null;
  placements: Record<AdPlacementKey, { enabled: boolean; slotId: string | null }>;
};

// Pure, DB-independent - the actual serialization shape that goes over the
// wire to the public endpoint. Split out from getPublicMonetizationConfig so
// it's directly unit-testable without a database connection.
export function buildPublicMonetizationConfig(
  settings: { mode: MonetizationMode; publisherId: string | null },
  placements: Array<{ key: AdPlacementKey; enabled: boolean; slotId: string | null }>
): PublicMonetizationConfig {
  const placementsByKey = {} as PublicMonetizationConfig["placements"];
  for (const placement of placements) {
    placementsByKey[placement.key] = {
      enabled: placement.enabled,
      slotId: placement.slotId,
    };
  }

  return {
    mode: settings.mode,
    publisherId: settings.publisherId,
    placements: placementsByKey,
  };
}

export async function getPublicMonetizationConfig(): Promise<PublicMonetizationConfig> {
  return getOrSetCache(PUBLIC_CONFIG_CACHE_KEY, PUBLIC_CONFIG_CACHE_TTL_MS, async () => {
    const [settings, placements] = await Promise.all([
      getMonetizationSettings(),
      listAdPlacements(),
    ]);

    return buildPublicMonetizationConfig(settings, placements);
  });
}

async function audit(
  actorUserId: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata: Record<string, unknown> = {}
) {
  await db.insert(auditLogs).values({
    actorUserId,
    action,
    targetType,
    targetId,
    metadata,
  });
}
