import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
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
import { env } from "../../shared/env";
import { badRequest, getErrorMessage, notFound } from "../../shared/errors";
import { writeAuditLog } from "../../shared/audit/audit.service";
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
} from "../weekly-strong-backtest/weekly-strong-backtest.generation";
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
import { listProviderSettings, updateProviderSettings } from "../data-provider/data-provider-settings.service";
import type { DataProviderSettingsRow } from "../data-provider/data-provider.types";
import { closeMarketStreamProviderByKey } from "../market-stream/market-stream.service";
import { addJobWithTimeout, getMarketDataQueue } from "../jobs/queues";
import { logger } from "../../shared/logger";
import type { adminUserSortFields } from "./admin.schemas";

export type AdminUserSortField = (typeof adminUserSortFields)[number];

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

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "user.role_updated",
    targetType: "user",
    targetId: input.userId,
    metadata: { role: input.role },
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

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "user.plan_updated",
    targetType: "user",
    targetId: input.userId,
    metadata: { plan: input.plan },
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

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "user.deleted",
    targetType: "user",
    targetId: input.userId,
    metadata: { email: deleted.email },
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

// Operational admin view: enabled, configuration, and health are kept as three separate fields - never conflated - so "enabled=ON, health=Error" stays a valid, meaningful state.
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

  // A true -> false transition force-closes any open realtime connection immediately rather than waiting for its own cycle (see market-stream.service.ts); re-enabling needs no matching force-reconnect since subscribe requests lazily reconnect on demand.
  if (before?.enabled && !updated.enabled) {
    try {
      closeMarketStreamProviderByKey(updated.key);
    } catch (error) {
      logger.warn(
        {
          provider: updated.key,
          message: getErrorMessage(error, "Unknown error"),
        },
        "Failed to close realtime connection after provider disable"
      );
    }
  }

  return updated;
}

export async function createProviderConnectUrl(actorUserId: string) {
  const url = getProviderConnectUrl();
  await writeAuditLog({
    actorUserId,
    action: "data_provider.connect_url_created",
    targetType: "data_provider",
  });
  return { url };
}

export async function completeProviderConnection(input: {
  actorUserId?: string;
  requestToken: string;
}) {
  const connection = await saveProviderToken({ requestToken: input.requestToken });
  await writeAuditLog({
    actorUserId: input.actorUserId ?? null,
    action: "data_provider.connected",
    targetType: "data_provider",
    targetId: connection.id,
  });
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
          message: getErrorMessage(error, "Sync failed"),
        },
        "Ingestion job failed"
      );
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: getErrorMessage(error, "Sync failed"),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "data_provider.instrument_sync_triggered",
    targetType: "sync_job",
    targetId: job.id,
    metadata: { exchange: input.exchange },
  });
  return job;
}

// Runs inline (not via the queue-branch pattern above) — ~22 sequential HTTP requests plus a few bulk UPDATEs finish in seconds, so there's no queue worker registered for this job type.
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
        message: getErrorMessage(error, "Sync failed"),
      },
      "Ingestion job failed"
    );
    await db
      .update(syncJobs)
      .set({
        status: JOB_STATUS.failed,
        errorMessage: getErrorMessage(error, "Sync failed"),
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "data_provider.sector_classification_sync_triggered",
    targetType: "sync_job",
    targetId: job.id,
  });
  return job;
}

// Same inline pattern as triggerSectorClassificationSync above — run "Sync Indices" first so there's something to backfill history for.
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
        message: getErrorMessage(error, "Backfill failed"),
      },
      "Ingestion job failed"
    );
    await db
      .update(syncJobs)
      .set({
        status: JOB_STATUS.failed,
        errorMessage: getErrorMessage(error, "Backfill failed"),
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "data_provider.index_candle_backfill_triggered",
    targetType: "sync_job",
    targetId: job.id,
  });
  return job;
}

// Refreshes latestClose/latestChangePct/latestVolume for every known instrument without the heavier "Sync NSE" metadata resync — a standalone catch-up since gainers/decliners filtering needs these columns populated market-wide.
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
          message: getErrorMessage(error, "Price refresh failed"),
        },
        "Ingestion job failed"
      );
      await db
        .update(syncJobs)
        .set({
          status: JOB_STATUS.failed,
          errorMessage: getErrorMessage(error, "Price refresh failed"),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "data_provider.price_refresh_triggered",
    targetType: "sync_job",
    targetId: job.id,
    metadata: { exchange: input.exchange },
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
  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_data.candles_backfilled",
    targetType: "instrument",
    targetId: input.symbol,
    metadata: { from: input.from, to: input.to, result },
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

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "branding.updated",
    targetType: "branding",
    targetId: String(BRANDING_DEFAULTS.id),
    metadata: { enabled: input.enabled },
  });
  return settings;
}

const BACKTEST_QUEUE_UNAVAILABLE_ERROR = "Backtest queue is currently unavailable. Retry once it recovers.";

// No queue configured at all -> always runs inline, in every environment (pre-existing, approved
// small-deployment behavior, unchanged here). A queue that IS configured but rejects the enqueue
// (unreachable Redis) is different: in production that must persist a failed+error state instead
// of ever running a potentially-heavy backfill inline inside the API request; only outside
// production does it fall back inline, as a loudly-logged local convenience.
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

  let runInline = !queue;

  if (queue) {
    try {
      await addJobWithTimeout(
        queue,
        JOB_NAMES.weeklyStrongBacktestBackfill,
        { syncJobId: job.id, collectionId: input.collectionId, weeks: input.weeks },
        { jobId: `weekly-strong-backtest-backfill:${input.collectionId}` }
      );
    } catch (error) {
      logger.warn(
        { collectionId: input.collectionId, syncJobId: job.id, message: getErrorMessage(error, "Unknown error") },
        "Weekly Strong backtest backfill: failed to enqueue job (Redis configured but unreachable?)"
      );

      if (env.NODE_ENV === "production") {
        await db
          .update(syncJobs)
          .set({ status: JOB_STATUS.failed, errorMessage: BACKTEST_QUEUE_UNAVAILABLE_ERROR, updatedAt: new Date() })
          .where(eq(syncJobs.id, job.id));

        await writeAuditLog({
          actorUserId: input.actorUserId,
          action: "weekly_strong_backtest.backfill_triggered",
          targetType: "market_collection",
          targetId: input.collectionId,
          metadata: { weeks: input.weeks, queueUnavailable: true },
        });

        return { syncJobId: job.id, status: JOB_STATUS.failed };
      }

      logger.warn(
        { collectionId: input.collectionId, syncJobId: job.id },
        "Weekly Strong backtest backfill: running inline (development-only fallback)"
      );
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.running, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
      runInline = true;
    }
  }

  if (runInline) {
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
          errorMessage: getErrorMessage(error, "Backfill failed"),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "weekly_strong_backtest.backfill_triggered",
    targetType: "market_collection",
    targetId: input.collectionId,
    metadata: { weeks: input.weeks },
  });

  return { syncJobId: job.id, status: job.status };
}

// Same no-queue-always-inline / configured-but-unreachable-branches-by-environment pattern as
// triggerWeeklyStrongBacktestBackfill above; reuses runWeeklyStrongBacktestHistoricalRebuild
// grouped per resolved membership version, not a blind recompute of every collection.
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

  let runInline = !queue;

  if (queue) {
    try {
      await addJobWithTimeout(
        queue,
        JOB_NAMES.weeklyStrongBacktestHistoricalRebuild,
        { syncJobId: job.id, collectionId: input.collectionId },
        { jobId: `weekly-strong-backtest-historical-rebuild:${input.collectionId}` }
      );
    } catch (error) {
      logger.warn(
        { collectionId: input.collectionId, syncJobId: job.id, message: getErrorMessage(error, "Unknown error") },
        "Weekly Strong backtest historical rebuild: failed to enqueue job (Redis configured but unreachable?)"
      );

      if (env.NODE_ENV === "production") {
        await db
          .update(syncJobs)
          .set({ status: JOB_STATUS.failed, errorMessage: BACKTEST_QUEUE_UNAVAILABLE_ERROR, updatedAt: new Date() })
          .where(eq(syncJobs.id, job.id));

        await writeAuditLog({
          actorUserId: input.actorUserId,
          action: "weekly_strong_backtest.historical_rebuild_triggered",
          targetType: "market_collection",
          targetId: input.collectionId,
          metadata: { queueUnavailable: true },
        });

        return { syncJobId: job.id, status: JOB_STATUS.failed };
      }

      logger.warn(
        { collectionId: input.collectionId, syncJobId: job.id },
        "Weekly Strong backtest historical rebuild: running inline (development-only fallback)"
      );
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.running, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
      runInline = true;
    }
  }

  if (runInline) {
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
          errorMessage: getErrorMessage(error, "Historical rebuild failed"),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));
      throw error;
    }
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "weekly_strong_backtest.historical_rebuild_triggered",
    targetType: "market_collection",
    targetId: input.collectionId,
  });

  return { syncJobId: job.id, status: job.status };
}

export {
  getWeeklyStrongBacktestHistoricalStatus,
  getWeeklyStrongBacktestStatus,
} from "../weekly-strong-backtest/weekly-strong-backtest.status";
