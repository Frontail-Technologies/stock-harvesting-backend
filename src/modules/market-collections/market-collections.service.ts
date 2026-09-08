import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import {
  instruments,
  marketCollectionMembers,
  marketCollections,
  marketCollectionVersionMembers,
  marketCollectionVersions,
  weeklyStrongBacktestRuns,
} from "../../db/schema";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import { conflict, notFound } from "../../shared/errors";
import { normalizeSymbol } from "../../shared/normalize";
import { normalizeBseCollectionFilename } from "./market-collections.filename";
import {
  getOrComputeCollectionRelativeStrengthBase,
  getOrComputeWeeklyStrongSnapshot,
  invalidateCollectionSnapshots,
} from "../market-data/dashboard-snapshots.service";
import {
  deriveSectorIndustryTaxonomy,
  groupRelativeStrengthMetrics,
  NSE_NORMAL_EQUITY_SYMBOL_PATTERN,
  pickTopRelativeStrengthRows,
} from "../market-data/market-data.service";

// The expensive live computation now lives behind a persisted, change-invalidated snapshot (dashboard-snapshots.service.ts); this in-process cache just collapses concurrent requests in front of that fast DB read, it's not the source of freshness truth.
const COLLECTION_CACHE_TTL_MS = 60_000;

// 500-row chunks (1,500/501 params per batch) - comfortably under Postgres's 65,535-param protocol limit, matching the convention used elsewhere in this codebase.
const COLLECTION_MEMBER_WRITE_CHUNK_SIZE = 500;

type MemberStatus = "new" | "already-active" | "reactivate";

type CollectionImportReport = {
  matched: Array<{ symbol: string; instrumentId: string; status: MemberStatus }>;
  unmatched: string[];
  duplicate: string[];
  invalid: string[];
  toDeactivate: Array<{ symbol: string; instrumentId: string }>;
  summary: {
    toAddCount: number;
    toReactivateCount: number;
    alreadyActiveCount: number;
    toDeactivateCount: number;
    unmatchedCount: number;
    duplicateCount: number;
    invalidCount: number;
  };
};

export async function listCollections(input: { exchange?: string; countryCode?: string }) {
  const filters = [
    eq(marketCollections.active, true),
    input.exchange ? eq(marketCollections.exchange, input.exchange) : undefined,
    input.countryCode ? eq(marketCollections.countryCode, input.countryCode) : undefined,
  ].filter(Boolean);

  return db
    .select({
      id: marketCollections.id,
      code: marketCollections.code,
      name: marketCollections.name,
      exchange: marketCollections.exchange,
      countryCode: marketCollections.countryCode,
      preparationStatus: marketCollections.preparationStatus,
      preparedAt: marketCollections.preparedAt,
      preparationError: marketCollections.preparationError,
      membersWithRequiredHistory: marketCollections.membersWithRequiredHistory,
      membersUnavailable: marketCollections.membersUnavailable,
      // Table-qualified on both sides deliberately: an unqualified "id" here resolves to market_collection_members' own PK, not marketCollections.id, silently making the correlation always-false and memberCount always 0 (confirmed via .toSQL()).
      memberCount: sql<number>`(
        select count(*)::int from "market_collection_members"
        where "market_collection_members"."collection_id" = "market_collections"."id"
        and "market_collection_members"."active" = true
      )`,
    })
    .from(marketCollections)
    .where(and(...filters))
    .orderBy(asc(marketCollections.name));
}

export async function getCollection(id: string) {
  const collection = await requireCollectionById(id);
  const [{ memberCount }] = await db
    .select({ memberCount: count() })
    .from(marketCollectionMembers)
    .where(and(eq(marketCollectionMembers.collectionId, id), eq(marketCollectionMembers.active, true)));

  return { ...collection, memberCount };
}

export async function getCollectionMembers(input: {
  code: string;
  page: number;
  limit: number;
  q?: string;
  sortBy?: "symbol" | "name";
  sortDirection?: "asc" | "desc";
}) {
  const collection = await requireCollectionByCode(input.code);
  return getCollectionMembersForCollection(collection, input);
}

// Admin variant — resolves by id and doesn't require the collection to be active, so a deactivated collection's list is still viewable in admin (the public code-based lookup above 404s on inactive collections).
export async function getCollectionMembersById(input: {
  id: string;
  page: number;
  limit: number;
  q?: string;
  sortBy?: "symbol" | "name";
  sortDirection?: "asc" | "desc";
}) {
  const collection = await requireCollectionById(input.id);
  return getCollectionMembersForCollection(collection, input);
}

async function getCollectionMembersForCollection(
  collection: { id: string; code: string; name: string },
  input: {
    page: number;
    limit: number;
    q?: string;
    sortBy?: "symbol" | "name";
    sortDirection?: "asc" | "desc";
  }
) {
  const cacheKey = [
    "collectionMembers",
    collection.code,
    input.page,
    input.limit,
    input.q ?? "",
    input.sortBy ?? "",
    input.sortDirection ?? "",
  ].join(":");

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const offset = (input.page - 1) * input.limit;
    const filters = [
      eq(marketCollectionMembers.collectionId, collection.id),
      eq(marketCollectionMembers.active, true),
      input.q
        ? or(
            ilike(instruments.symbol, `%${normalizeSymbol(input.q)}%`),
            ilike(instruments.name, `%${input.q.trim()}%`)
          )
        : undefined,
    ].filter(Boolean);
    const sortColumn = input.sortBy === "name" ? instruments.name : instruments.symbol;
    const direction = input.sortDirection === "desc" ? desc : asc;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          instrumentId: instruments.id,
          instrumentToken: instruments.instrumentToken,
          exchange: instruments.exchange,
          tradingSymbol: instruments.symbol,
          name: instruments.name,
        })
        .from(marketCollectionMembers)
        .innerJoin(instruments, eq(marketCollectionMembers.instrumentId, instruments.id))
        .where(and(...filters))
        .orderBy(direction(sortColumn), asc(instruments.symbol))
        .limit(input.limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(marketCollectionMembers)
        .innerJoin(instruments, eq(marketCollectionMembers.instrumentId, instruments.id))
        .where(and(...filters)),
    ]);

    return {
      collection: { code: collection.code, name: collection.name, memberCount: total },
      items: rows,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / input.limit)),
      },
    };
  });
}

// getOrComputeCollectionRelativeStrengthBase runs the expensive base computation once per invalidation cycle; deriving the requested view (top-N or grouping) from that stored base is cheap, so every {limit, groupBy} combination shares one snapshot.
export async function getCollectionRelativeStrength(input: {
  code: string;
  limit: number;
  groupBy?: "sector" | "industry";
}) {
  const collection = await requireCollectionByCode(input.code);
  const cacheKey = `collectionRelativeStrength:${collection.code}:${input.limit}:${input.groupBy ?? ""}`;

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const { metrics: baseMetrics, asOfDate } = await getOrComputeCollectionRelativeStrengthBase(
      collection.id,
      collection.exchange,
      memberRows
    );

    if (input.groupBy) {
      const groups = groupRelativeStrengthMetrics(baseMetrics, input.groupBy, input.limit);
      return {
        collection: { code: collection.code, name: collection.name, exchange: collection.exchange },
        groups,
        asOfDate,
      };
    }

    const metrics = pickTopRelativeStrengthRows(baseMetrics, input.limit);
    return {
      collection: { code: collection.code, name: collection.name, exchange: collection.exchange },
      metrics,
      asOfDate,
    };
  });
}

// Full sector -> industries taxonomy for active members, no ranking/top-N/scores: the Dashboard's cross-filter needs the complete mapping (a ranked/limited sample would leave stocks outside the top-N unresolvable). Shares the same cached base snapshot as getCollectionRelativeStrength above - just a different, complete derivation of it.
export async function getCollectionSectorIndustryTaxonomy(input: { code: string }) {
  const collection = await requireCollectionByCode(input.code);
  const cacheKey = `collectionSectorIndustryTaxonomy:${collection.code}`;

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const { metrics: baseMetrics, asOfDate } = await getOrComputeCollectionRelativeStrengthBase(
      collection.id,
      collection.exchange,
      memberRows
    );

    return {
      collection: { code: collection.code, name: collection.name, exchange: collection.exchange },
      sectors: deriveSectorIndustryTaxonomy(baseMetrics),
      asOfDate,
    };
  });
}

// The Weekly Strong breakout screen (see weekly-strong-evaluator.ts for qualification logic), scoped to this collection's active members; reads a persisted snapshot instead of re-running computeWeeklyStrongStocks live - see getOrComputeWeeklyStrongSnapshot.
export async function getCollectionWeeklyStrongStocks(input: { code: string }) {
  const collection = await requireCollectionByCode(input.code);
  const cacheKey = `collectionWeeklyStrongStocks:${collection.code}`;

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const { items, weekEnding } = await getOrComputeWeeklyStrongSnapshot(
      collection.id,
      collection.exchange,
      memberRows
    );
    return {
      collection: { code: collection.code, name: collection.name },
      items,
      weekEnding,
    };
  });
}

// Shared by the two functions above and weekly-strong-backtest.generation.ts.
export async function getActiveMemberInstrumentRows(collectionId: string) {
  return db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
      sector: instruments.sector,
      industry: instruments.industry,
    })
    .from(marketCollectionMembers)
    .innerJoin(instruments, eq(marketCollectionMembers.instrumentId, instruments.id))
    .where(
      and(eq(marketCollectionMembers.collectionId, collectionId), eq(marketCollectionMembers.active, true))
    );
}

type NewCollectionInput = {
  code: string;
  name: string;
  exchange: string;
  countryCode?: string;
  description?: string;
};

function normalizeNewCollectionInput(input: NewCollectionInput) {
  return {
    code: input.code.trim().toUpperCase(),
    name: input.name,
    exchange: input.exchange,
    countryCode: input.countryCode ?? "IN",
    description: input.description ?? null,
  };
}

export async function createCollection(input: NewCollectionInput & { actorUserId: string }) {
  const values = normalizeNewCollectionInput(input);
  const [existing] = await db
    .select({ id: marketCollections.id })
    .from(marketCollections)
    .where(and(eq(marketCollections.exchange, values.exchange), eq(marketCollections.code, values.code)));
  if (existing) {
    throw conflict(`A collection with code "${values.code}" already exists for ${values.exchange}`);
  }

  const [created] = await db.insert(marketCollections).values(values).returning();

  invalidateCacheByPrefix("collections:list");
  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_collection.created",
    targetType: "market_collection",
    targetId: created.id,
    metadata: { code: values.code, exchange: values.exchange },
  });
  return created;
}

export async function findCollectionByCode(exchange: string, code: string) {
  const normalizedCode = code.trim().toUpperCase();
  const [collection] = await db
    .select()
    .from(marketCollections)
    .where(and(eq(marketCollections.exchange, exchange), eq(marketCollections.code, normalizedCode)));
  return collection ?? null;
}

export async function updateCollection(input: {
  id: string;
  name?: string;
  description?: string | null;
  active?: boolean;
  actorUserId: string;
}) {
  const collection = await requireCollectionById(input.id);
  const [updated] = await db
    .update(marketCollections)
    .set({
      name: input.name ?? collection.name,
      description: input.description === undefined ? collection.description : input.description,
      active: input.active ?? collection.active,
      updatedAt: new Date(),
    })
    .where(eq(marketCollections.id, input.id))
    .returning();

  invalidateCacheByPrefix("collections:list");
  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_collection.updated",
    targetType: "market_collection",
    targetId: input.id,
    metadata: { name: input.name, active: input.active },
  });
  return updated;
}

export async function previewCollectionImport(input: { id: string; csvContent: string }) {
  const collection = await requireCollectionById(input.id);
  return classifyCollectionImport(collection, input.csvContent);
}

// Confirming an import atomically: (1) updates the active-flag, (2) creates one new immutable market_collection_versions snapshot dated effectiveFrom, (3) invalidates backtest runs; an existing version for that exact effectiveFrom rejects the import instead of silently overwriting (use replaceCollectionVersionMembers for a correction). `id` can also be a NewCollectionInput (bulk-import create path), inserted in the SAME transaction so creation and first import commit/roll back together.
export async function importCollectionCsv(input: {
  id: string | NewCollectionInput;
  csvContent: string;
  sourceName?: string;
  sourceDate?: string;
  effectiveFrom: string;
  actorUserId: string;
}) {
  const isNewCollection = typeof input.id !== "string";
  const existingCollection = isNewCollection ? null : await requireCollectionById(input.id as string);
  const exchange = isNewCollection ? (input.id as NewCollectionInput).exchange : existingCollection!.exchange;

  const report = await classifyCollectionImport(
    { id: isNewCollection ? null : (input.id as string), exchange },
    input.csvContent
  );
  const activeMembershipChanged =
    report.summary.toAddCount + report.summary.toReactivateCount + report.summary.toDeactivateCount > 0;

  const { collectionId, code, versionId, invalidatedCurrentMembershipRuns, invalidatedHistoricalWeeks, created } =
    await db.transaction(async (tx) => {
      let collectionId: string;
      let code: string;
      let sourceNameFallback: string | null;
      let sourceDateFallback: string | null;
      let created = false;

      if (isNewCollection) {
        const values = normalizeNewCollectionInput(input.id as NewCollectionInput);
        const [existing] = await tx
          .select({ id: marketCollections.id })
          .from(marketCollections)
          .where(and(eq(marketCollections.exchange, values.exchange), eq(marketCollections.code, values.code)));
        if (existing) {
          throw conflict(`A collection with code "${values.code}" already exists for ${values.exchange}`);
        }
        const [createdRow] = await tx.insert(marketCollections).values(values).returning();
        collectionId = createdRow.id;
        code = createdRow.code;
        sourceNameFallback = null;
        sourceDateFallback = null;
        created = true;
      } else {
        collectionId = existingCollection!.id;
        code = existingCollection!.code;
        sourceNameFallback = existingCollection!.sourceName;
        sourceDateFallback = existingCollection!.sourceDate;
      }

      const [existingVersion] = await tx
        .select({ id: marketCollectionVersions.id })
        .from(marketCollectionVersions)
        .where(
          and(
            eq(marketCollectionVersions.collectionId, collectionId),
            eq(marketCollectionVersions.effectiveFrom, input.effectiveFrom)
          )
        );
      if (existingVersion) {
        throw conflict(
          `A membership version effective ${input.effectiveFrom} already exists for this collection. ` +
            "Use the version correction workflow to replace it instead of re-importing."
        );
      }

      await upsertMatchedCollectionMembers(tx, collectionId, report.matched);
      await deactivateCollectionMembers(tx, collectionId, report.toDeactivate.map((row) => row.instrumentId));

      await tx
        .update(marketCollections)
        .set({
          sourceName: input.sourceName ?? sourceNameFallback,
          sourceDate: input.sourceDate ?? sourceDateFallback,
          lastImportedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(marketCollections.id, collectionId));

      // current_membership runs mean "active set AT GENERATION TIME" - if this import changed the active set, invalidate the whole current_membership series so old/new weeks never silently mix universes; regeneration stays an explicit admin action (no auto-rebuild). historical_membership runs are untouched, being keyed to point-in-time versions, not "now".
      let invalidatedCurrentMembershipRuns = 0;
      if (activeMembershipChanged) {
        const deletedCurrentRuns = await tx
          .delete(weeklyStrongBacktestRuns)
          .where(
            and(
              eq(weeklyStrongBacktestRuns.collectionId, collectionId),
              eq(weeklyStrongBacktestRuns.membershipMode, "current_membership")
            )
          )
          .returning({ id: weeklyStrongBacktestRuns.id });
        invalidatedCurrentMembershipRuns = deletedCurrentRuns.length;
      }

      // The version's member snapshot is the uploaded file's full matched symbol list, regardless of each row's status against the PREVIOUS active set - it's the complete desired membership as of effectiveFrom.
      const [version] = await tx
        .insert(marketCollectionVersions)
        .values({
          collectionId,
          effectiveFrom: input.effectiveFrom,
          sourceName: input.sourceName ?? null,
          sourceDate: input.sourceDate ?? null,
          createdBy: input.actorUserId,
          memberCount: report.matched.length,
        })
        .returning();

      if (report.matched.length > 0) {
        await tx.insert(marketCollectionVersionMembers).values(
          report.matched.map((row) => ({
            versionId: version.id,
            instrumentId: row.instrumentId,
            symbol: row.symbol,
            exchange,
          }))
        );
      }

      // Every confirmed import resets candle/backtest readiness - a previously READY collection must never keep showing READY once membership changed; latestMembershipVersionId is captured here and re-checked by prepareCollectionData so a superseded preparation job can never win.
      await tx
        .update(marketCollections)
        .set({
          preparationStatus: "pending",
          preparedAt: null,
          preparationError: null,
          membersWithRequiredHistory: null,
          membersUnavailable: null,
          latestMembershipVersionId: version.id,
        })
        .where(eq(marketCollections.id, collectionId));

      // New-version invalidation: this version is authoritative for [effectiveFrom, next version's effectiveFrom or unbounded); any historical_membership run in that window was resolved against a now-superseded version, so delete it rather than leave the series silently wrong - "Rebuild Historical Backtest" regenerates it. Scoped precisely to this window; other weeks/collections/versions are untouched.
      const [nextVersion] = await tx
        .select({ effectiveFrom: marketCollectionVersions.effectiveFrom })
        .from(marketCollectionVersions)
        .where(
          and(
            eq(marketCollectionVersions.collectionId, collectionId),
            gt(marketCollectionVersions.effectiveFrom, input.effectiveFrom)
          )
        )
        .orderBy(asc(marketCollectionVersions.effectiveFrom))
        .limit(1);

      const historicalWindowFilters = [
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, "historical_membership"),
        gte(weeklyStrongBacktestRuns.weekEnding, input.effectiveFrom),
        ...(nextVersion ? [lt(weeklyStrongBacktestRuns.weekEnding, nextVersion.effectiveFrom)] : []),
      ];
      const invalidatedHistoricalWeeks = (
        await tx
          .delete(weeklyStrongBacktestRuns)
          .where(and(...historicalWindowFilters))
          .returning({ weekEnding: weeklyStrongBacktestRuns.weekEnding })
      )
        .map((row) => row.weekEnding)
        .sort();

      return {
        collectionId,
        code,
        versionId: version.id,
        invalidatedCurrentMembershipRuns,
        invalidatedHistoricalWeeks,
        created,
      };
    });

  invalidateCacheByPrefix("collections:list");
  invalidateCacheByPrefix(`collectionMembers:${code}:`);
  invalidateCacheByPrefix(`collectionRelativeStrength:${code}:`);
  invalidateCacheByPrefix(`collectionWeeklyStrongStocks:${code}`);
  invalidateCacheByPrefix(`collectionWeeklyStrongBacktest:${code}`);
  // The authoritative invalidation for the persisted snapshot (the in-process caches above are just a safety-net layer); the next read of either metric type recomputes once and re-persists.
  await invalidateCollectionSnapshots(collectionId);

  if (created) {
    await writeAuditLog({
      actorUserId: input.actorUserId,
      action: "market_collection.created",
      targetType: "market_collection",
      targetId: collectionId,
      metadata: { code, exchange },
    });
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_collection.imported",
    targetType: "market_collection",
    targetId: collectionId,
    metadata: {
      summary: report.summary,
      effectiveFrom: input.effectiveFrom,
      versionId,
      invalidatedCurrentMembershipRuns,
      invalidatedHistoricalWeeks,
    },
  });

  return {
    ...report,
    collectionId,
    versionId,
    effectiveFrom: input.effectiveFrom,
    invalidatedCurrentMembershipRuns,
    invalidatedHistoricalWeeks,
    created,
  };
}

// Identity (name/code) is always derived from `filename` via the one canonical normalizeBseCollectionFilename - callers never supply their own code/name for a bulk-import file.
export async function previewBulkImportFile(input: { exchange: string; filename: string; csvContent: string }) {
  const { name, code } = normalizeBseCollectionFilename(input.filename);
  const existing = await findCollectionByCode(input.exchange, code);
  const report = await classifyCollectionImport(
    existing ? { id: existing.id, exchange: input.exchange } : { id: null, exchange: input.exchange },
    input.csvContent
  );
  return { report, existingCollectionId: existing?.id ?? null, name, code };
}

export async function importBulkFile(input: {
  exchange: string;
  filename: string;
  csvContent: string;
  sourceName?: string;
  sourceDate?: string;
  effectiveFrom: string;
  actorUserId: string;
}) {
  const { name, code } = normalizeBseCollectionFilename(input.filename);
  const existing = await findCollectionByCode(input.exchange, code);

  const result = await importCollectionCsv({
    id: existing ? existing.id : { code, name, exchange: input.exchange },
    csvContent: input.csvContent,
    sourceName: input.sourceName,
    sourceDate: input.sourceDate,
    effectiveFrom: input.effectiveFrom,
    actorUserId: input.actorUserId,
  });

  return { ...result, name, code };
}

// Batched INSERT ... ON CONFLICT for matched rows (already-active rows need no write).
export async function upsertMatchedCollectionMembers(
  tx: DbOrTx,
  collectionId: string,
  matched: Array<{ instrumentId: string; status: MemberStatus }>
) {
  const rowsToUpsert = matched.filter((row) => row.status !== "already-active");
  for (let index = 0; index < rowsToUpsert.length; index += COLLECTION_MEMBER_WRITE_CHUNK_SIZE) {
    const chunk = rowsToUpsert.slice(index, index + COLLECTION_MEMBER_WRITE_CHUNK_SIZE);
    await tx
      .insert(marketCollectionMembers)
      .values(chunk.map((row) => ({ collectionId, instrumentId: row.instrumentId, active: true })))
      .onConflictDoUpdate({
        target: [marketCollectionMembers.collectionId, marketCollectionMembers.instrumentId],
        set: { active: true, updatedAt: new Date() },
      });
  }
}

// Batched deactivation - collectionId stays a real equality filter (not folded into the IN-list) so this can never cross-affect another collection's row for the same instrument.
export async function deactivateCollectionMembers(tx: DbOrTx, collectionId: string, instrumentIds: string[]) {
  for (let index = 0; index < instrumentIds.length; index += COLLECTION_MEMBER_WRITE_CHUNK_SIZE) {
    const chunk = instrumentIds.slice(index, index + COLLECTION_MEMBER_WRITE_CHUNK_SIZE);
    await tx
      .update(marketCollectionMembers)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(marketCollectionMembers.collectionId, collectionId), inArray(marketCollectionMembers.instrumentId, chunk)));
  }
}

export async function resolveCollectionInstrumentMatches(exchange: string, candidateSymbols: string[]) {
  const instrumentRows =
    candidateSymbols.length > 0
      ? await db
          .select({ id: instruments.id, symbol: instruments.symbol })
          .from(instruments)
          .where(and(eq(instruments.exchange, exchange), inArray(instruments.symbol, candidateSymbols)))
      : [];
  const instrumentIdBySymbol = new Map(instrumentRows.map((row) => [row.symbol, row.id]));
  const unmatched = candidateSymbols.filter((symbol) => !instrumentIdBySymbol.has(symbol));

  return { instrumentIdBySymbol, unmatched };
}

async function classifyCollectionImport(
  collection: { id: string | null; exchange: string },
  csvContent: string
): Promise<CollectionImportReport> {
  const { candidateSymbols, duplicates, invalid } = parseCollectionCsv(csvContent);
  const { instrumentIdBySymbol, unmatched } = await resolveCollectionInstrumentMatches(
    collection.exchange,
    candidateSymbols
  );

  // A null id means "this collection doesn't exist yet" (bulk-import create path previewing before creation) - no current membership to diff against, so every matched symbol classifies as "new" and nothing is queued for deactivation.
  const currentMembers = collection.id
    ? await db
        .select({
          instrumentId: marketCollectionMembers.instrumentId,
          symbol: instruments.symbol,
          active: marketCollectionMembers.active,
        })
        .from(marketCollectionMembers)
        .innerJoin(instruments, eq(marketCollectionMembers.instrumentId, instruments.id))
        .where(eq(marketCollectionMembers.collectionId, collection.id))
    : [];
  const activeMemberInstrumentIds = new Set(
    currentMembers.filter((member) => member.active).map((member) => member.instrumentId)
  );
  const knownMemberInstrumentIds = new Set(currentMembers.map((member) => member.instrumentId));

  const matched = candidateSymbols
    .filter((symbol) => instrumentIdBySymbol.has(symbol))
    .map((symbol) => {
      const instrumentId = instrumentIdBySymbol.get(symbol) as string;
      const status: MemberStatus = activeMemberInstrumentIds.has(instrumentId)
        ? "already-active"
        : knownMemberInstrumentIds.has(instrumentId)
          ? "reactivate"
          : "new";
      return { symbol, instrumentId, status };
    });

  const matchedInstrumentIds = new Set(matched.map((row) => row.instrumentId));
  const toDeactivate = currentMembers
    .filter((member) => member.active && !matchedInstrumentIds.has(member.instrumentId))
    .map((member) => ({ symbol: member.symbol, instrumentId: member.instrumentId }));

  return {
    matched,
    unmatched,
    duplicate: duplicates,
    invalid,
    toDeactivate,
    summary: {
      toAddCount: matched.filter((row) => row.status === "new").length,
      toReactivateCount: matched.filter((row) => row.status === "reactivate").length,
      alreadyActiveCount: matched.filter((row) => row.status === "already-active").length,
      toDeactivateCount: toDeactivate.length,
      unmatchedCount: unmatched.length,
      duplicateCount: duplicates.length,
      invalidCount: invalid.length,
    },
  };
}

// Accepts a bare newline list, a single-column CSV with a "symbol" header, or NSE's own index-constituent CSV export; uses the "symbol" header if present, otherwise the first field per line, and reports non-ticker-shaped entries as invalid rather than dropping them. Reused as-is by market-collection-versions.service.ts's replace/correction workflow.
export function parseCollectionCsv(csvContent: string) {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { candidateSymbols: [], duplicates: [], invalid: [] };

  const headerCells = (lines[0] ?? "").split(",").map((cell) => cell.trim().toLowerCase());
  const namedSymbolColumn = headerCells.indexOf("symbol");
  const hasHeader = namedSymbolColumn !== -1 || /symbol/i.test(lines[0] ?? "");
  const startIndex = hasHeader ? 1 : 0;
  const symbolColumn = namedSymbolColumn !== -1 ? namedSymbolColumn : 0;
  const symbolPattern = new RegExp(NSE_NORMAL_EQUITY_SYMBOL_PATTERN);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const invalid: string[] = [];
  const candidateSymbols: string[] = [];

  for (let index = startIndex; index < lines.length; index++) {
    const rawToken = lines[index]?.split(",")[symbolColumn]?.trim().toUpperCase() ?? "";
    if (!rawToken) continue;

    if (!symbolPattern.test(rawToken)) {
      invalid.push(rawToken);
      continue;
    }
    if (seen.has(rawToken)) {
      duplicates.add(rawToken);
      continue;
    }
    seen.add(rawToken);
    candidateSymbols.push(rawToken);
  }

  return { candidateSymbols, duplicates: [...duplicates], invalid };
}

// Exported for weekly-strong-backtest.generation.ts's admin (by id) and weekly-strong-backtest.queries.ts's public (by code) lookups - same active/404 rules, not reimplemented there.
export async function requireCollectionById(id: string) {
  const [collection] = await db.select().from(marketCollections).where(eq(marketCollections.id, id));
  if (!collection) throw notFound("Collection not found");
  return collection;
}

export async function requireCollectionByCode(code: string) {
  const [collection] = await db
    .select()
    .from(marketCollections)
    .where(
      and(eq(marketCollections.code, code.trim().toUpperCase()), eq(marketCollections.active, true))
    )
    .limit(1);
  if (!collection) throw notFound("Collection not found");
  return collection;
}
