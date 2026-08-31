import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { auditLogs, dataProviderSettings } from "../../db/schema";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import { DATA_PROVIDER_SETTINGS_SEEDS } from "../../shared/constants";
import { notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";

const SETTINGS_CACHE_KEY = "dataProviderSettings:map";
// Deliberately short - admin changes must propagate to the next market-data
// request without a redeploy or restart (see routing layer), so this only
// ever protects against read amplification on a hot path, not correctness.
const SETTINGS_CACHE_TTL_MS = 20_000;

// Health writes are triggered from genuinely hot paths (every candle
// request/sync can call recordProviderSuccess) - throttle both success and
// failure writes per provider key so an active symbol doesn't hammer the
// settings row every request. A real failure is still captured within one
// throttle window, which is good enough for an operational status display.
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

export type DataProviderSettingsRow = typeof dataProviderSettings.$inferSelect;

export async function listProviderSettings(): Promise<DataProviderSettingsRow[]> {
  await ensureSeeded();
  return db.select().from(dataProviderSettings);
}

// Last successfully-read snapshot, kept outside the short TTL cache above so
// a DB hiccup (or, on a fresh deploy, the migration for this table simply
// not having run yet) can fall back to it instead of throwing. This is a
// hot path called from market-data.service.ts on effectively every
// candle/instrument request - it must never be the reason an unrelated
// endpoint (e.g. GET /api/market-data/exchanges) starts 500ing.
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
          message: error instanceof Error ? error.message : "Unknown error",
          usingLastKnownGood: lastKnownGoodSettingsMap !== null,
        },
        "Failed to read data_provider_settings - falling back rather than failing the caller"
      );
    }
    return lastKnownGoodSettingsMap;
  }
}

// No successful read has EVER happened (map is null, not just stale) - this
// only occurs on a fresh deploy before the migration has run, or a DB that's
// down from the very first request. Every provider currently implemented
// worked unconditionally before this feature existed, so "fail open" here
// preserves that behavior rather than silently breaking market data
// entirely because a settings table can't be read. This is different from
// "override a previously-confirmed disabled provider" (which this never
// does - a real disabled row is only ever produced by a successful read).
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

  await db.insert(auditLogs).values({
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

// Called by the routing layer (data-provider.registry.ts) whenever anything
// else changes provider-relevant state that eligibility depends on (OAuth
// connect/disconnect), not just from this module's own writes.
//
// Also invalidates "supportedExchanges" (owned by market-data.service.ts):
// that list's fixed NSE/BSE/BSE_IDX entries are gated on the same
// isProviderEnabled() checks, so a disable/enable must be reflected in the
// exchange picker immediately, not after its independent 24h TTL.
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

  // Health tracking is a best-effort operational nice-to-have - it must
  // never be a reason the actual candle/instrument fetch it's reporting on
  // fails, so failures here are swallowed (after one warning) rather than
  // thrown.
  try {
    await ensureSeeded();
    await db
      .update(dataProviderSettings)
      .set(patch)
      .where(eq(dataProviderSettings.key, key));
    invalidateProviderSettingsCache();
  } catch (error) {
    logger.warn(
      { key, message: error instanceof Error ? error.message : "Unknown error" },
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
