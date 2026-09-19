import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  backgroundJobRuns,
  brandingSettings,
  syncJobs,
  users,
} from "../../db/schema";
import {
  BRANDING_DEFAULTS,
  DEFAULT_USER_PLAN,
  JOB_NAMES,
  JOB_STATUS,
  SYNC_JOB_TYPES,
  USER_ROLE,
  type UserPlan,
  type UserRole,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { badRequest, conflict, getErrorMessage, notFound } from "../../shared/errors";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { hashPassword, normalizeEmail } from "../security/passwords";
import {
  backfillDailyCandles,
  backfillIndexCandles,
  refreshAllLatestInstrumentPrices,
  refreshDailyCandles,
  syncProviderInstruments,
} from "../market-data/market-data.service";
import { syncSectorClassifications } from "../market-data/sector-classification.service";
import {
  runWeeklyStrongBacktestBackfill,
  runWeeklyStrongBacktestHistoricalRebuild,
} from "../weekly-strong-backtest/weekly-strong-backtest.generation";
import {
  getAllProviderLocalStatuses,
  getProviderHealth,
  getProviderStatus,
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

export async function createAdminUser(input: {
  actorUserId: string;
  email: string;
  name: string;
  password: string;
}) {
  const email = normalizeEmail(input.email);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw conflict("A user with this email already exists");

  const passwordHash = await hashPassword(input.password);

  const [created] = await db
    .insert(users)
    .values({
      email,
      name: input.name,
      passwordHash,
      role: USER_ROLE.admin,
      plan: DEFAULT_USER_PLAN,
      emailVerifiedAt: new Date(),
    })
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      plan: users.plan,
      createdAt: users.createdAt,
    });

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "user.created",
    targetType: "user",
    targetId: created.id,
    metadata: { email: created.email, role: created.role },
  });

  return created;
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

// Local/DB-derived only - no external provider request (see
// getAllProviderLocalStatuses). Kept a thin passthrough so the route layer
// doesn't reach across modules.
export async function getAdminProviderStatuses() {
  return getAllProviderLocalStatuses();
}

// External connectivity check for one provider, bounded by
// checkConnectionWithTimeout. Separate endpoint so the admin page can load it
// as an independent background query per provider.
export async function getAdminProviderHealth(provider: string) {
  return getProviderHealth(provider);
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

  // A retired provider's settings row (e.g. the old zerodha one) is kept in the DB but has no adapter, so it is never listed.
  return settingsRows
    .filter((row) => getDataProviderAdapterByProvider(row.key) !== null)
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

async function failStaleSyncJobs() {
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000);
  await db.update(syncJobs).set({
    status: JOB_STATUS.failed,
    errorMessage: "Job stopped reporting progress before completion",
    updatedAt: new Date(),
  }).where(and(
    inArray(syncJobs.status, [JOB_STATUS.queued, JOB_STATUS.running]),
    lt(syncJobs.updatedAt, staleBefore),
  ));
}

async function assertNoActiveSyncJob(type: string, identityKey?: string, identityValue?: string) {
  await failStaleSyncJobs();
  const conditions = [eq(syncJobs.type, type), inArray(syncJobs.status, [JOB_STATUS.queued, JOB_STATUS.running])];
  if (identityKey && identityValue) conditions.push(sql`${syncJobs.payload} ->> ${identityKey} = ${identityValue}`);
  const [activeJob] = await db.select({ id: syncJobs.id }).from(syncJobs).where(and(...conditions)).limit(1);
  if (activeJob) conflict("This job is already queued or running");
}

async function assertBacktestCooldown(type: string, collectionId: string) {
  const cooldownStartedAt = new Date(Date.now() - 10 * 60 * 1000);
  const [recentJob] = await db.select({ id: syncJobs.id }).from(syncJobs).where(and(
    eq(syncJobs.type, type),
    eq(syncJobs.status, JOB_STATUS.completed),
    gte(syncJobs.updatedAt, cooldownStartedAt),
    sql`${syncJobs.payload} ->> 'collectionId' = ${collectionId}`,
  )).limit(1);
  if (recentJob) conflict("This backtest completed recently. Please wait 10 minutes before running it again");
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
      payload: { exchange: input.exchange, progress: 0 },
    })
    .returning();

  if (queue) {
    try {
      await addJobWithTimeout(queue, JOB_NAMES.instrumentSync, {
        syncJobId: job.id,
        exchange: input.exchange,
      });
    } catch (error) {
      await db.update(syncJobs).set({
        status: JOB_STATUS.failed,
        errorMessage: getErrorMessage(error, "Could not queue instrument sync"),
        updatedAt: new Date(),
      }).where(eq(syncJobs.id, job.id));
      throw error;
    }
  } else {
    try {
      const result = await syncProviderInstruments(input.exchange);
      await refreshAllLatestInstrumentPrices(input.exchange);
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: { ...result, progress: 100 }, updatedAt: new Date() })
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
  await assertNoActiveSyncJob(SYNC_JOB_TYPES.sectorClassificationSync);
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.sectorClassificationSync,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { progress: 0 },
    })
    .returning();

  if (queue) {
    try {
      await addJobWithTimeout(queue, JOB_NAMES.sectorClassificationSync, { syncJobId: job.id });
    } catch (error) {
      await db.update(syncJobs).set({ status: JOB_STATUS.failed, errorMessage: getErrorMessage(error, "Could not queue sector sync"), updatedAt: new Date() }).where(eq(syncJobs.id, job.id));
      throw error;
    }
  } else try {
    const result = await syncSectorClassifications();
    await db
      .update(syncJobs)
      .set({ status: JOB_STATUS.completed, payload: { ...result, progress: 100 }, updatedAt: new Date() })
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
  await assertNoActiveSyncJob(SYNC_JOB_TYPES.indexCandleBackfill, "exchange", input.exchange);
  await assertNoActiveSyncJob(SYNC_JOB_TYPES.instrumentSync, "exchange", input.exchange);
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.indexCandleBackfill,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { exchange: input.exchange, progress: 0 },
    })
    .returning();

  if (queue) {
    try {
      await addJobWithTimeout(queue, JOB_NAMES.indexCandleBackfill, { syncJobId: job.id, exchange: input.exchange });
    } catch (error) {
      await db.update(syncJobs).set({ status: JOB_STATUS.failed, errorMessage: getErrorMessage(error, "Could not queue index backfill"), updatedAt: new Date() }).where(eq(syncJobs.id, job.id));
      throw error;
    }
  } else try {
    const result = await backfillIndexCandles(input.exchange);
    await db
      .update(syncJobs)
      .set({ status: JOB_STATUS.completed, payload: { ...result, progress: 100 }, updatedAt: new Date() })
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

// Refreshes latestClose/latestChangePct/latestVolume for every known instrument without the heavier instrument-metadata resync — a standalone catch-up since gainers/decliners filtering needs these columns populated market-wide.
export async function triggerPriceRefresh(input: {
  actorUserId: string;
  exchange: string;
}) {
  await assertNoActiveSyncJob(SYNC_JOB_TYPES.priceRefresh, "exchange", input.exchange);
  const queue = getMarketDataQueue();
  const [job] = await db
    .insert(syncJobs)
    .values({
      type: SYNC_JOB_TYPES.priceRefresh,
      status: queue ? JOB_STATUS.queued : JOB_STATUS.running,
      payload: { exchange: input.exchange, progress: 0 },
    })
    .returning();

  if (queue) {
    try {
      await addJobWithTimeout(queue, JOB_NAMES.priceRefresh, {
        syncJobId: job.id,
        exchange: input.exchange,
      });
    } catch (error) {
      await db.update(syncJobs).set({
        status: JOB_STATUS.failed,
        errorMessage: getErrorMessage(error, "Could not queue price refresh"),
        updatedAt: new Date(),
      }).where(eq(syncJobs.id, job.id));
      throw error;
    }
  } else {
    try {
      const result = await refreshAllLatestInstrumentPrices(input.exchange);
      await db
        .update(syncJobs)
        .set({ status: JOB_STATUS.completed, payload: { ...result, progress: 100 }, updatedAt: new Date() })
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

export async function triggerDailyCandleRefresh(input: { actorUserId: string; symbol: string }) {
  // An explicit admin refresh deliberately re-queries an instrument already confirmed as having no history.
  const result = await refreshDailyCandles({ symbol: input.symbol, forceRecheck: true });
  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_data.daily_candles_refreshed",
    targetType: "instrument",
    targetId: input.symbol,
    metadata: { result },
  });
  return result;
}

// Job payloads can carry large arrays (e.g. every failed index symbol). The job table only needs
// the scalar fields (exchange, counts, progress), so arrays and nested objects are dropped here.
export function toJobListPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)),
  );
}

export async function listJobs() {
  await failStaleSyncJobs();
  const rows = await db.select().from(syncJobs).orderBy(desc(syncJobs.createdAt)).limit(50);
  return rows.map((row) => ({ ...row, payload: toJobListPayload(row.payload) }));
}

const ACTIVE_JOB_STATUSES = new Set<string>(["queued", "running"]);
const STALE_JOB_DELETE_AFTER_MS = 10 * 60 * 1000;

// Removes one row from the job history. A scheduled-but-not-yet-due ("pending") run is never
// deleted. A queued or running job can only be deleted once it has shown no progress for
// STALE_JOB_DELETE_AFTER_MS, so a live job's progress updates never target a deleted row while a
// stuck or orphaned one (e.g. its queue entry is gone) can still be cleared by hand.
export async function deleteJobHistoryEntry(input: { actorUserId: string; id: string; source: "run" | "provider"; now?: Date }) {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_JOB_DELETE_AFTER_MS);
  const table = input.source === "run" ? backgroundJobRuns : syncJobs;
  const [existing] = await db
    .select({ status: table.status, updatedAt: table.updatedAt })
    .from(table)
    .where(eq(table.id, input.id))
    .limit(1);
  if (!existing) throw notFound("Job not found");

  const isPending = existing.status === "pending";
  const isActive = ACTIVE_JOB_STATUSES.has(existing.status);
  const isStale = existing.updatedAt.getTime() <= staleBefore.getTime();
  if (isPending) throw conflict("This job is scheduled and hasn't started yet, so it can't be deleted.");
  if (isActive && !isStale) {
    throw conflict("This job is still active. It can be deleted once it has shown no progress for 10 minutes.");
  }

  const [deleted] = await db
    .delete(table)
    .where(and(
      eq(table.id, input.id),
      sql`(${table.status}::text NOT IN ('pending', 'queued', 'running') OR (${table.status}::text <> 'pending' AND ${table.updatedAt} <= ${staleBefore}))`,
    ))
    .returning({ id: table.id });
  if (!deleted) throw conflict("This job is still active. It can be deleted once it has shown no progress for 10 minutes.");

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "job.deleted",
    targetType: input.source === "run" ? "background_job_run" : "sync_job",
    targetId: input.id,
    metadata: { status: existing.status, stale: isActive },
  });
  return { id: deleted.id };
}

export async function getAdminAnalytics(input: { period: "all" | "today" | "7d" | "30d" | "90d" }) {
  const days = input.period === "today" ? 1 : input.period === "7d" ? 7 : input.period === "30d" ? 30 : input.period === "90d" ? 90 : null;
  const today = sql`(now() at time zone 'Asia/Kolkata')::date`;
  const userFilter = days === null
    ? sql`true`
    : sql`(created_at at time zone 'Asia/Kolkata')::date >= ${today} - ${days - 1} * interval '1 day'`;
  const jobFilter = days === null
    ? sql`true`
    : sql`(created_at at time zone 'Asia/Kolkata')::date >= ${today} - ${days - 1} * interval '1 day'`;
  const userSeriesStart = days === null
    ? sql`COALESCE((SELECT min(created_at at time zone 'Asia/Kolkata')::date FROM users), ${today})`
    : sql`${today} - ${days - 1} * interval '1 day'`;
  const jobSeriesStart = days === null
    ? sql`COALESCE(LEAST((SELECT min(created_at at time zone 'Asia/Kolkata')::date FROM sync_jobs), (SELECT min(created_at at time zone 'Asia/Kolkata')::date FROM background_job_runs)), (SELECT min(created_at at time zone 'Asia/Kolkata')::date FROM sync_jobs), (SELECT min(created_at at time zone 'Asia/Kolkata')::date FROM background_job_runs), ${today})`
    : sql`${today} - ${days - 1} * interval '1 day'`;
  const [summaryResult, growthResult, plansResult, jobsResult, readinessResult] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT count(*) FROM users) AS total_users,
        (SELECT count(*) FROM users WHERE email_verified_at IS NOT NULL) AS verified_users,
        (SELECT count(*) FROM users WHERE ${userFilter}) AS new_users_30d,
        (SELECT count(*) FROM market_collections WHERE active = true) AS active_segments,
        (SELECT count(*) FROM market_collection_members WHERE active = true) AS total_members,
        (SELECT count(*) FROM sync_jobs WHERE status IN ('queued', 'running')) +
          (SELECT count(*) FROM background_job_runs WHERE status IN ('pending', 'queued', 'running')) AS active_jobs
    `),
    db.execute(sql`
      WITH days AS (SELECT generate_series(${userSeriesStart}, ${today}, interval '1 day')::date AS day)
      SELECT days.day::text, count(users.id)::int AS users
      FROM days LEFT JOIN users ON (users.created_at at time zone 'Asia/Kolkata')::date = days.day
      GROUP BY days.day ORDER BY days.day
    `),
    db.execute(sql`SELECT plan::text AS name, count(*)::int AS value FROM users WHERE ${userFilter} GROUP BY plan ORDER BY value DESC`),
    db.execute(sql`
      WITH days AS (SELECT generate_series(${jobSeriesStart}, ${today}, interval '1 day')::date AS day),
      jobs AS (
        SELECT (created_at at time zone 'Asia/Kolkata')::date AS day, status::text AS status FROM sync_jobs WHERE ${jobFilter}
        UNION ALL
        SELECT (created_at at time zone 'Asia/Kolkata')::date AS day, status::text AS status FROM background_job_runs WHERE ${jobFilter}
      )
      SELECT days.day::text,
        count(*) FILTER (WHERE jobs.status = 'completed')::int AS successful,
        count(*) FILTER (WHERE jobs.status IN ('partial', 'failed', 'missed'))::int AS failed
      FROM days LEFT JOIN jobs ON jobs.day = days.day
      GROUP BY days.day ORDER BY days.day
    `),
    db.execute(sql`SELECT preparation_status::text AS name, count(*)::int AS value FROM market_collections GROUP BY preparation_status ORDER BY value DESC`),
  ]);
  const summary = summaryResult.rows[0] ?? {};
  const number = (value: unknown) => Number(value ?? 0);
  const jobRows = jobsResult.rows.map((row) => ({ day: String(row.day), successful: number(row.successful), failed: number(row.failed) }));
  const successfulJobs = jobRows.reduce((sum, row) => sum + row.successful, 0);
  const failedJobs = jobRows.reduce((sum, row) => sum + row.failed, 0);
  return {
    summary: {
      totalUsers: number(summary.total_users),
      verifiedUsers: number(summary.verified_users),
      newUsers30d: number(summary.new_users_30d),
      activeSegments: number(summary.active_segments),
      totalMembers: number(summary.total_members),
      activeJobs: number(summary.active_jobs),
      jobSuccessRate: successfulJobs + failedJobs > 0 ? Math.round((successfulJobs / (successfulJobs + failedJobs)) * 100) : 100,
    },
    userGrowth: growthResult.rows.map((row) => ({ day: String(row.day), users: number(row.users) })),
    plans: plansResult.rows.map((row) => ({ name: String(row.name), value: number(row.value) })),
    jobs: jobRows,
    segmentReadiness: readinessResult.rows.map((row) => ({ name: String(row.name), value: number(row.value) })),
  };
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
  await assertNoActiveSyncJob(SYNC_JOB_TYPES.weeklyStrongBacktestBackfill, "collectionId", input.collectionId);
  await assertBacktestCooldown(SYNC_JOB_TYPES.weeklyStrongBacktestBackfill, input.collectionId);
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
  await assertNoActiveSyncJob(SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild, "collectionId", input.collectionId);
  await assertBacktestCooldown(SYNC_JOB_TYPES.weeklyStrongBacktestHistoricalRebuild, input.collectionId);
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
