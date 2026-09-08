import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { dataProviderSettings } from "../../db/schema";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import { DATA_PROVIDER_SETTINGS_SEEDS } from "../../shared/constants";
import { getErrorMessage, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import type { DataProviderSettingsRow } from "./data-provider.types";

const SETTINGS_CACHE_KEY = "dataProviderSettings:map";
// Deliberately short - admin changes must propagate without a redeploy/restart, so this only guards against read amplification, not correctness.
const SETTINGS_CACHE_TTL_MS = 20_000;

// Health writes are triggered from hot paths (every candle request/sync) - throttled per provider key so an active symbol doesn't hammer the settings row; a real failure is still captured within one window.
const HEALTH_WRITE_MIN_INTERVAL_MS = 60_000;
const lastHealthWriteAtByKey = new Map<string, number>();

async function ensureSeeded() {
  await db
    .insert(dataProviderSettings)
    .values(
      DATA_PROVIDER_SETTINGS_SEEDS.map((seed) => ({
        key: seed.key,
        displayName: seed.displayName,
        priority: seed.priority,
      }))
    )
    .onConflictDoNothing();
}

export async function listProviderSettings(): Promise<DataProviderSettingsRow[]> {
  await ensureSeeded();
  return db.select().from(dataProviderSettings);
}

// Last successfully-read snapshot, kept outside the TTL cache so a DB hiccup or unrun migration can fall back to it instead of throwing - this hot path must never make an unrelated endpoint start 500ing.
let lastKnownGoodSettingsMap: Map<string, DataProviderSettingsRow> | null = null;
let loggedSettingsReadFailure = false;

async function getProviderSettingsMap(): Promise<Map<string, DataProviderSettingsRow> | null> {
  try {
    const map = await getOrSetCache(SETTINGS_CACHE_KEY, SETTINGS_CACHE_TTL_MS, async () => {
      const rows = await listProviderSettings();
      return new Map(rows.map((row) => [row.key, row]));
    });
    lastKnownGoodSettingsMap = map;
    loggedSettingsReadFailure = false;
    return map;
  } catch (error) {
    if (!loggedSettingsReadFailure) {
      loggedSettingsReadFailure = true;
      logger.warn(
        {
          message: getErrorMessage(error, "Unknown error"),
          usingLastKnownGood: lastKnownGoodSettingsMap !== null,
        },
        "Failed to read data_provider_settings - falling back rather than failing the caller"
      );
    }
    return lastKnownGoodSettingsMap;
  }
}

// map === null means no successful read has EVER happened (fresh deploy pre-migration, or DB down from the first request) - "fail open" here preserves pre-feature behavior; it never overrides a real, successfully-read disabled row.
export async function isProviderEnabled(key: string): Promise<boolean> {
  const map = await getProviderSettingsMap();
  if (!map) return true;
  return map.get(key)?.enabled ?? true;
}

export async function getProviderPriority(key: string): Promise<number> {
  const map = await getProviderSettingsMap();
  if (!map) return 100;
  return map.get(key)?.priority ?? 100;
}

export async function updateProviderSettings(input: {
  key: string;
  enabled?: boolean;
  priority?: number;
  disabledReason?: string | null;
  actorUserId: string;
}): Promise<DataProviderSettingsRow> {
  await ensureSeeded();
  const [existing] = await db
    .select()
    .from(dataProviderSettings)
    .where(eq(dataProviderSettings.key, input.key))
    .limit(1);
  if (!existing) throw notFound("Data provider not found");

  const [row] = await db
    .update(dataProviderSettings)
    .set({
      enabled: input.enabled ?? existing.enabled,
      priority: input.priority ?? existing.priority,
      disabledReason:
        input.disabledReason !== undefined ? input.disabledReason : existing.disabledReason,
      updatedAt: new Date(),
      updatedBy: input.actorUserId,
    })
    .where(eq(dataProviderSettings.key, input.key))
    .returning();

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "data_provider.settings_updated",
    targetType: "data_provider_settings",
    targetId: input.key,
    metadata: {
      previousEnabled: existing.enabled,
      newEnabled: row.enabled,
      previousPriority: existing.priority,
      newPriority: row.priority,
    },
  });

  invalidateProviderSettingsCache();
  return row;
}

// Called by the routing layer whenever anything else changes provider-relevant eligibility state (e.g. OAuth connect/disconnect); also invalidates "supportedExchanges" (market-data.service.ts) since it's gated on the same isProviderEnabled() checks and must reflect a disable/enable immediately, not after its own 24h TTL.
export function invalidateProviderSettingsCache() {
  invalidateCacheByPrefix("dataProviderSettings");
  invalidateCacheByPrefix("providerEligibility");
  invalidateCacheByPrefix("supportedExchanges");
}

async function recordHealth(
  key: string,
  patch: Partial<{ lastSuccessAt: Date; lastFailureAt: Date; lastError: string | null }>
) {
  const last = lastHealthWriteAtByKey.get(key) ?? 0;
  if (Date.now() - last < HEALTH_WRITE_MIN_INTERVAL_MS) return;
  lastHealthWriteAtByKey.set(key, Date.now());

  // Health tracking is best-effort - failures here are swallowed (after one warning) so it never breaks the fetch it's reporting on.
  try {
    await ensureSeeded();
    await db
      .update(dataProviderSettings)
      .set(patch)
      .where(eq(dataProviderSettings.key, key));
    invalidateProviderSettingsCache();
  } catch (error) {
    logger.warn(
      { key, message: getErrorMessage(error, "Unknown error") },
      "Failed to record data provider health"
    );
  }
}

export async function recordProviderSuccess(key: string) {
  await recordHealth(key, { lastSuccessAt: new Date() });
}

export async function recordProviderFailure(key: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  await recordHealth(key, { lastFailureAt: new Date(), lastError: message.slice(0, 480) });
}
