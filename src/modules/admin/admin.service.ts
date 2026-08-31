import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  auditLogs,
  brandingSettings,
  syncJobs,
  users,
} from "../../db/schema";
import {
  BRANDING_DEFAULTS,
  JOB_NAMES,
  JOB_STATUS,
  SYNC_JOB_TYPES,
  type UserPlan,
  type UserRole,
} from "../../shared/constants";
import { badRequest, notFound } from "../../shared/errors";
import {
  backfillDailyCandles,
  backfillIndexCandles,
  refreshAllLatestInstrumentPrices,
  syncProviderInstruments,
} from "../market-data/market-data.service";
import { syncSectorClassifications } from "../market-data/sector-classification.service";
import {
  runWeeklyStrongBacktestBackfill,
  runWeeklyStrongBacktestHistoricalRebuild,
} from "../weekly-strong-backtest/weekly-strong-backtest.service";
import {
  getAllProviderStatuses,
  getProviderConnectUrl,
  getProviderStatus,
  saveProviderToken,
} from "../data-provider/data-provider.service";
import {
  getDataProviderAdapterByProvider,
  getProviderCapabilities,
  listDataProviderAdapters,
} from "../data-provider/data-provider.registry";
import {
  listProviderSettings,
  updateProviderSettings,
  type DataProviderSettingsRow,
} from "../data-provider/data-provider-settings.service";
import { closeMarketStreamProviderByKey } from "../market-stream/market-stream.service";
import { getMarketDataQueue } from "../jobs/queues";
import { logger } from "../../shared/logger";

export type AdminUserSortField = "name" | "email" | "role" | "plan" | "createdAt";

export async function listAdminUsers(input: {
  q?: string;
  role?: UserRole;
  plan?: UserPlan;
  page: number;
  limit: number;
  sort: AdminUserSortField;
  direction: "asc" | "desc";
}) {
  const offset = (input.page - 1) * input.limit;
  const trimmedQuery = input.q?.trim();
  const filters = [
    trimmedQuery
      ? or(
          ilike(users.name, `%${trimmedQuery}%`),
          ilike(users.email, `%${trimmedQuery}%`)
        )
      : undefined,
    input.role ? eq(users.role, input.role) : undefined,
    input.plan ? eq(users.plan, input.plan) : undefined,
  ].filter(Boolean);
  const whereClause = filters.length > 0 ? and(...filters) : undefined;
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(whereClause);
  const totalUsers = Number(total ?? 0);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      plan: users.plan,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(whereClause)
    .orderBy(getAdminUserOrderBy(input.sort, input.direction))
    .limit(input.limit)
    .offset(offset);

  return {
    users: rows,
    pagination: {
      page: input.page,
      limit: input.limit,
      total: totalUsers,
      totalPages: Math.max(1, Math.ceil(totalUsers / input.limit)),
    },
  };
}

export async function exportAdminUsersCsv(input: {
  q?: string;
  role?: UserRole;
  plan?: UserPlan;
  sort: AdminUserSortField;
  direction: "asc" | "desc";
}) {
  const trimmedQuery = input.q?.trim();
  const filters = [
    trimmedQuery
      ? or(
          ilike(users.name, `%${trimmedQuery}%`),
          ilike(users.email, `%${trimmedQuery}%`)
        )
      : undefined,
    input.role ? eq(users.role, input.role) : undefined,
    input.plan ? eq(users.plan, input.plan) : undefined,
  ].filter(Boolean);
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select({
      name: users.name,
      email: users.email,
      role: users.role,
      plan: users.plan,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(whereClause)
    .orderBy(getAdminUserOrderBy(input.sort, input.direction));

  return buildUsersCsv(rows);
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildUsersCsv(
  rows: Array<{
    name: string | null;
    email: string;
    role: string;
    plan: string;
    createdAt: Date | string;
  }>
) {
  const header = ["Name", "Email", "Role", "Plan", "Created At"];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.name ?? "",
        row.email,
        row.role,
        row.plan,
        new Date(row.createdAt).toISOString(),
      ]
        .map((value) => csvCell(String(value)))
        .join(",")
    );
  }

  return lines.join("\r\n");
}

function getAdminUserOrderBy(
  sort: AdminUserSortField,
  direction: "asc" | "desc"
) {
  const column =
    sort === "name"
      ? users.name
      : sort === "email"
        ? users.email
        : sort === "role"
          ? users.role
          : sort === "plan"
            ? users.plan
            : users.createdAt;

  return direction === "asc" ? asc(column) : desc(column);
}

export async function updateUserRole(input: {
  actorUserId: string;
  userId: string;
  role: UserRole;
}) {
  const [updated] = await db
    .update(users)
    .set({ role: input.role, updatedAt: new Date() })
    .where(eq(users.id, input.userId))
    .returning();
  if (!updated) throw notFound("User not found");

  await audit(input.actorUserId, "user.role_updated", "user", input.userId, {
    role: input.role,
  });
  return updated;
}

export async function updateUserPlan(input: {
  actorUserId: string;
  userId: string;
  plan: UserPlan;
}) {
  const [updated] = await db
    .update(users)
    .set({ plan: input.plan, updatedAt: new Date() })
    .where(eq(users.id, input.userId))
    .returning();
  if (!updated) throw notFound("User not found");

  await audit(input.actorUserId, "user.plan_updated", "user", input.userId, {
    plan: input.plan,
  });
  return updated;
}

export async function deleteUser(input: { actorUserId: string; userId: string }) {
  if (input.actorUserId === input.userId) {
    throw badRequest("You can't delete your own admin account");
  }

  const [deleted] = await db
    .delete(users)
    .where(eq(users.id, input.userId))
    .returning();
  if (!deleted) throw notFound("User not found");

  await audit(input.actorUserId, "user.deleted", "user", input.userId, {
    email: deleted.email,
  });
  return { id: deleted.id };
}

export async function getAdminProviderStatus() {
  return getProviderStatus();
}

export async function getAdminProviderStatuses() {
  return getAllProviderStatuses();
}

export type AdminDataProviderHealth = "disabled" | "healthy" | "error" | "unknown";

export function deriveDataProviderHealth(input: {
  enabled: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}): AdminDataProviderHealth {
  if (!input.enabled) return "disabled";
  if (!input.lastSuccessAt && !input.lastFailureAt) return "unknown";

  const mostRecentIsFailure =
    input.lastFailureAt &&
    (!input.lastSuccessAt || input.lastFailureAt.getTime() >= input.lastSuccessAt.getTime());

  return mostRecentIsFailure ? "error" : "healthy";
}

// Operational admin view: enabled (admin decision), configuration (env/OAuth
// presence, from the existing getProviderStatus), and health (derived from
// tracked success/failure timestamps) are kept as three explicit, separate
// fields - never conflated - per the "enabled=ON, health=Error is a valid,
// meaningful state" requirement.
export async function getAdminDataProviderSettings() {
  const [settingsRows, statuses] = await Promise.all([
    listProviderSettings(),
    Promise.all(
      listDataProviderAdapters().map(async (adapter) => ({
        provider: adapter.providerKey,
        status: await getProviderStatus(adapter.providerKey),
      }))
    ),
  ]);
  const statusByProvider = new Map(statuses.map((entry) => [entry.provider, entry.status]));

  return settingsRows
    .map((row) => {
      const adapter = getDataProviderAdapterByProvider(row.key);
      const status = statusByProvider.get(row.key);
      const configured = adapter
        ? adapter.requiresConnection
          ? Boolean(status?.connected)
          : Boolean(status?.providerConfigured)
        : false;

      return {
        key: row.key,
        displayName: row.displayName,
        enabled: row.enabled,
        priority: row.priority,
        disabledReason: row.disabledReason,
        configured,
        capabilities: adapter ? getProviderCapabilities(adapter) : [],
        health: deriveDataProviderHealth({
          enabled: row.enabled,
          lastSuccessAt: row.lastSuccessAt,
          lastFailureAt: row.lastFailureAt,
        }),
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
        lastError: row.lastError,
        updatedAt: row.updatedAt.toISOString(),
      };
    })
    .sort((a, b) => a.priority - b.priority);
}

export async function updateAdminDataProviderSettings(input: {
  actorUserId: string;
  key: string;
  enabled?: boolean;
  priority?: number;
  disabledReason?: string | null;
}) {
  const before: DataProviderSettingsRow | undefined = (await listProviderSettings()).find(
    (row) => row.key === input.key
  );

  const updated = await updateProviderSettings(input);

  // A true -> false transition also force-closes any open realtime
  // connection for this provider immediately, rather than waiting for its
  // own close/reconnect cycle to notice - see market-stream.service.ts.
  // Re-enabling doesn't need a matching force-reconnect: subscribe requests
  // already lazily (re)connect on demand, so the next relevant subscription
  // naturally picks the provider back up.
  if (before?.enabled && !updated.enabled) {
    try {
      closeMarketStreamProviderByKey(updated.key);
    } catch (error) {
      logger.warn(
        {
          provider: updated.key,
          message: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to close realtime connection after provider disable"
      );
    }
  }

  return updated;
}

export async function createProviderConnectUrl(actorUserId: string) {
  const url = getProviderConnectUrl();
  await audit(actorUserId, "data_provider.connect_url_created", "data_provider");
  return { url };
}

export async function completeProviderConnection(input: {
  actorUserId?: string;
  requestToken: string;
}) {
  const connection = await saveProviderToken({ requestToken: input.requestToken });
  await audit(
    input.actorUserId ?? null,
    "data_provider.connected",
    "data_provider",
    connection.id
  );
  return { connected: true };
}

export async function triggerInstrumentSync(input: {
  actorUserId: string;
  exchange: string;
}) {
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.instrumentSync,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { exchange: input.exchange },
    })
    .returning();

  if (queue) {
    await queue.add(JOB_NAMES.instrumentSync, {
      syncJobId: job.id,
      exchange: input.exchange,
    });
  } else {
    try {
      const result = await syncProviderInstruments(input.exchange);
      await refreshAllLatestInstrumentPrices(input.exchange);
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: result, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
    } catch (error) {
      logger.error(
        {
          syncJobId: job.id,
          type: SYNC_JOB_TYPES.instrumentSync,
          exchange: input.exchange,
          message: error instanceof Error ? error.message : "Sync failed",
        },
        "Ingestion job failed"
      );
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: error instanceof Error ? error.message : "Sync failed",
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await audit(input.actorUserId, "data_provider.instrument_sync_triggered", "sync_job", job.id, {
    exchange: input.exchange,
  });
  return job;
}

// Always runs inline rather than via the queue-branch pattern above — the
// whole sync is ~22 sequential HTTP requests (one per sector) plus a handful
// of bulk UPDATE statements, finishing in seconds, and there's no registered
// queue worker for this job type since it's never actually been worth
// offloading.
export async function triggerSectorClassificationSync(input: { actorUserId: string }) {
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.sectorClassificationSync,
      status: JOB_STATUS.running,
      payload: {},
    })
    .returning();

  try {
    const result = await syncSectorClassifications();
    await db
      .update(syncJobs)
      .set({ status: JOB_STATUS.completed, payload: result, updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
  } catch (error) {
    logger.error(
      {
        syncJobId: job.id,
        type: SYNC_JOB_TYPES.sectorClassificationSync,
        message: error instanceof Error ? error.message : "Sync failed",
      },
      "Ingestion job failed"
    );
    await db
      .update(syncJobs)
      .set({
        status: JOB_STATUS.failed,
        errorMessage: error instanceof Error ? error.message : "Sync failed",
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }

  await audit(
    input.actorUserId,
    "data_provider.sector_classification_sync_triggered",
    "sync_job",
    job.id,
    {}
  );
  return job;
}

// Same inline pattern as triggerSectorClassificationSync above — run "Sync
// Indices" (triggerInstrumentSync with exchange: "NSE_IDX", no new code
// needed there) first so there's something to backfill history for.
export async function triggerIndexCandleBackfill(input: {
  actorUserId: string;
  exchange?: string;
}) {
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.indexCandleBackfill,
      status: JOB_STATUS.running,
      payload: { exchange: input.exchange },
    })
    .returning();

  try {
    const result = await backfillIndexCandles(input.exchange);
    await db
      .update(syncJobs)
      .set({ status: JOB_STATUS.completed, payload: result, updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
  } catch (error) {
    logger.error(
      {
        syncJobId: job.id,
        type: SYNC_JOB_TYPES.indexCandleBackfill,
        message: error instanceof Error ? error.message : "Backfill failed",
      },
      "Ingestion job failed"
    );
    await db
      .update(syncJobs)
      .set({
        status: JOB_STATUS.failed,
        errorMessage: error instanceof Error ? error.message : "Backfill failed",
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }

  await audit(
    input.actorUserId,
    "data_provider.index_candle_backfill_triggered",
    "sync_job",
    job.id,
    {}
  );
  return job;
}

// Refreshes latestClose/latestChangePct/latestVolume for every already-known
// instrument, without re-syncing instrument metadata (the heavier, slower
// step "Sync NSE" also does). Gainers/decliners/unchanged filtering depends
// on these columns being populated across the whole market, not just
// whichever symbols a page happened to touch — this is the standalone way
// to (re)run that catch-up without waiting on a full instrument resync.
export async function triggerPriceRefresh(input: {
  actorUserId: string;
  exchange: string;
}) {
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.priceRefresh,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { exchange: input.exchange },
    })
    .returning();

  if (queue) {
    await queue.add(JOB_NAMES.priceRefresh, {
      syncJobId: job.id,
      exchange: input.exchange,
    });
  } else {
    try {
      const result = await refreshAllLatestInstrumentPrices(input.exchange);
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: result, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
    } catch (error) {
      logger.error(
        {
          syncJobId: job.id,
          type: SYNC_JOB_TYPES.priceRefresh,
          exchange: input.exchange,
          message: error instanceof Error ? error.message : "Price refresh failed",
        },
        "Ingestion job failed"
      );
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: error instanceof Error ? error.message : "Price refresh failed",
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await audit(input.actorUserId, "data_provider.price_refresh_triggered", "sync_job", job.id, {
    exchange: input.exchange,
  });
  return job;
}

export async function triggerCandleBackfill(input: {
  actorUserId: string;
  symbol: string;
  from: string;
  to: string;
}) {
  const result = await backfillDailyCandles(input);
  await audit(input.actorUserId, "market_data.candles_backfilled", "instrument", input.symbol, {
    from: input.from,
    to: input.to,
    result,
  });
  return result;
}

export async function listJobs() {
  return db.select().from(syncJobs).orderBy(desc(syncJobs.createdAt)).limit(50);
}

export async function getBrandingSettings() {
  const [settings] = await db
    .select()
    .from(brandingSettings)
    .where(eq(brandingSettings.id, BRANDING_DEFAULTS.id));
  if (settings) return settings;

  const [created] = await db
    .insert(brandingSettings)
    .values({ id: BRANDING_DEFAULTS.id })
    .onConflictDoNothing()
    .returning();

  return created;
}

export async function updateBrandingSettings(input: {
  actorUserId: string;
  brandName: string;
  watermarkText: string;
  logoUrl?: string | null;
  enabled: boolean;
}) {
  const [settings] = await db
    .insert(brandingSettings)
    .values({
      id: BRANDING_DEFAULTS.id,
      brandName: input.brandName,
      watermarkText: input.watermarkText,
      logoUrl: input.logoUrl ?? null,
      enabled: input.enabled,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: brandingSettings.id,
      set: {
        brandName: input.brandName,
        watermarkText: input.watermarkText,
        logoUrl: input.logoUrl ?? null,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();

  await audit(
    input.actorUserId,
    "branding.updated",
    "branding",
    String(BRANDING_DEFAULTS.id),
    {
      enabled: input.enabled,
    }
  );
  return settings;
}

// Same queued-if-Redis-else-inline pattern as triggerInstrumentSync above -
// works identically in an environment without REDIS_URL configured
// (worker.ts refuses to start there, so runTrackedJob's queue path would
// never actually execute).
export async function triggerWeeklyStrongBacktestBackfill(input: {
  actorUserId: string;
  collectionId: string;
  weeks?: number;
}) {
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.weeklyStrongBacktestBackfill,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { collectionId: input.collectionId, weeks: input.weeks },
    })
    .returning();

  if (queue) {
    await queue.add(JOB_NAMES.weeklyStrongBacktestBackfill, {
      syncJobId: job.id,
      collectionId: input.collectionId,
      weeks: input.weeks,
    });
  } else {
    try {
      const result = await runWeeklyStrongBacktestBackfill({
        collectionId: input.collectionId,
        weeks: input.weeks,
      });
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: result, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
    } catch (error) {
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: error instanceof Error ? error.message : "Backfill failed",
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await audit(input.actorUserId, "weekly_strong_backtest.backfill_triggered", "market_collection", input.collectionId, {
    weeks: input.weeks,
  });

  return { syncJobId: job.id, status: job.status };
}

// Same queued-if-Redis-else-inline pattern as triggerWeeklyStrongBacktestBackfill
// above. Reuses runWeeklyStrongBacktestHistoricalRebuild (Phase D) - grouped
// per resolved membership version, never blindly recomputing every
// collection.
export async function triggerWeeklyStrongBacktestHistoricalRebuild(input: {
  actorUserId: string;
  collectionId: string;
}) {
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { collectionId: input.collectionId },
    })
    .returning();

  if (queue) {
    await queue.add(JOB_NAMES.weeklyStrongBacktestHistoricalRebuild, {
      syncJobId: job.id,
      collectionId: input.collectionId,
    });
  } else {
    try {
      const result = await runWeeklyStrongBacktestHistoricalRebuild({ collectionId: input.collectionId });
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: result, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
    } catch (error) {
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: error instanceof Error ? error.message : "Historical rebuild failed",
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await audit(
    input.actorUserId,
    "weekly_strong_backtest.historical_rebuild_triggered",
    "market_collection",
    input.collectionId,
    {}
  );

  return { syncJobId: job.id, status: job.status };
}

export {
  getWeeklyStrongBacktestHistoricalStatus,
  getWeeklyStrongBacktestStatus,
} from "../weekly-strong-backtest/weekly-strong-backtest.service";

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
