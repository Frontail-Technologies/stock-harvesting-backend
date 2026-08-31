import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  auditLogs,
  instruments,
  marketCollectionMembers,
  marketCollections,
  marketCollectionVersionMembers,
  marketCollectionVersions,
  weeklyStrongBacktestRuns,
} from "../../db/schema";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import { conflict, notFound } from "../../shared/errors";
import { normalizeSymbol } from "../../shared/normalize";
import {
  getOrComputeCollectionRelativeStrengthBase,
  getOrComputeWeeklyStrongSnapshot,
  invalidateCollectionSnapshots,
} from "../market-data/dashboard-snapshots.service";
import {
  groupRelativeStrengthMetrics,
  NSE_NORMAL_EQUITY_SYMBOL_PATTERN,
  pickTopRelativeStrengthRows,
} from "../market-data/market-data.service";

// Phase D.10 - getCollectionRelativeStrength/getCollectionWeeklyStrongStocks
// used to wrap the EXPENSIVE live computation directly
// (computeRelativeStrengthMetrics/computeGroupRelativeStrength/
// computeWeeklyStrongStocks - years of candle history per active member,
// measured cold: ~0.8-3s). That expensive step now lives one layer down,
// behind a PERSISTED snapshot (dashboard-snapshots.service.ts /
// dashboard_metric_snapshots) that's invalidated when the underlying data
// actually changes (a real sync, or a confirmed import - see
// invalidateCollectionSnapshots below and
// market-data.service.ts's refreshAllLatestInstrumentPrices), not on a
// fixed TTL. What this in-process cache now sits in front of is a fast DB
// read (~100-300ms), not a multi-second computation - so its TTL is
// deliberately short (a safety-net micro-cache to collapse concurrent
// requests for the same collection within the same few seconds, not the
// source of freshness truth the way it used to have to be).
const COLLECTION_CACHE_TTL_MS = 60_000;

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
      // Table-qualified on both sides deliberately, not the bare-column
      // interpolation this used to use: drizzle's `sql` tag renders a
      // Column reference as just its column name, and
      // market_collection_members has its own `id` primary key - inside
      // this subquery's scope, an unqualified `"id"` resolves to THAT
      // (its own PK) rather than the intended outer marketCollections.id,
      // silently turning the correlation into collection_id = id (always
      // false) and making memberCount always 0. Confirmed via a live
      // diagnostic: the query builder's own .toSQL() showed
      // `where "collection_id" = "id"` with no table prefix.
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

// Admin variant — resolves by id and doesn't require the collection itself
// to be active, so a deactivated collection's constituent list is still
// viewable from its admin detail page (the public code-based lookup above
// intentionally 404s on inactive collections).
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

// Phase D.10 #1 - Sector and Industry (and, before this pass, an entirely
// unused third `limit:200` call from the Dashboard's own `rsQuery` - see
// the Phase D.10 report) each used to independently re-run the full
// candle-driven base computation. getOrComputeCollectionRelativeStrengthBase
// runs it ONCE per invalidation cycle (persisted) - deriving the
// requested view (a plain top-N list, or a sector/industry grouping) from
// that same stored base is pure/cheap (pickTopRelativeStrengthRows /
// groupRelativeStrengthMetrics - no candle I/O), so three different
// `{limit, groupBy}` combinations for the same collection now share one
// snapshot instead of independently recomputing.
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

// ChartInk-style "within 15% of its own multi-year closing high" breakout
// screen, scoped to this collection's active members. Phase D.10: reads a
// persisted snapshot instead of re-running computeWeeklyStrongStocks live
// on every request - see getOrComputeWeeklyStrongSnapshot.
export async function getCollectionWeeklyStrongStocks(input: { code: string }) {
  const collection = await requireCollectionByCode(input.code);
  const cacheKey = `collectionWeeklyStrongStocks:${collection.code}`;

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const items = await getOrComputeWeeklyStrongSnapshot(collection.id, collection.exchange, memberRows);
    return {
      collection: { code: collection.code, name: collection.name },
      items,
    };
  });
}

// Note: the old getCollectionWeeklyStrongStocksBacktest (count-only, live-
// computed on every request) has been removed - see
// weekly-strong-backtest.service.ts for the persisted replacement
// (Phase C2). getActiveMemberInstrumentRows below is still shared by the
// two functions above and that new module.
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

export async function createCollection(input: {
  code: string;
  name: string;
  exchange: string;
  countryCode?: string;
  description?: string;
  actorUserId: string;
}) {
  const code = input.code.trim().toUpperCase();
  const [existing] = await db
    .select({ id: marketCollections.id })
    .from(marketCollections)
    .where(and(eq(marketCollections.exchange, input.exchange), eq(marketCollections.code, code)));
  if (existing) {
    throw conflict(`A collection with code "${code}" already exists for ${input.exchange}`);
  }

  const [created] = await db
    .insert(marketCollections)
    .values({
      code,
      name: input.name,
      exchange: input.exchange,
      countryCode: input.countryCode ?? "IN",
      description: input.description ?? null,
    })
    .returning();

  invalidateCacheByPrefix("collections:list");
  await audit(input.actorUserId, "market_collection.created", "market_collection", created.id, {
    code,
    exchange: input.exchange,
  });
  return created;
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
  await audit(input.actorUserId, "market_collection.updated", "market_collection", input.id, {
    name: input.name,
    active: input.active,
  });
  return updated;
}

export async function previewCollectionImport(input: { id: string; csvContent: string }) {
  const collection = await requireCollectionById(input.id);
  return classifyCollectionImport(collection, input.csvContent);
}

// Confirming an import does several things atomically in ONE transaction:
// (1) the pre-existing active-flag update below, which stays the source
// of truth for current/live Dashboard reads (Phase D #16); (2) creates
// one new IMMUTABLE market_collection_versions snapshot dated
// `effectiveFrom` (Phase D #2, #4) - never during dry-run
// (previewCollectionImport above never calls this function); (3) Phase
// D.5 lifecycle correctness - see the two invalidation blocks inline
// below. If a version already exists for that exact effectiveFrom, the
// whole import is rejected (nothing is written) rather than silently
// overwritten - use replaceCollectionVersionMembers
// (market-collection-versions.service.ts) for an explicit, safeguarded
// correction instead.
export async function importCollectionCsv(input: {
  id: string;
  csvContent: string;
  sourceName?: string;
  sourceDate?: string;
  effectiveFrom: string;
  actorUserId: string;
}) {
  const collection = await requireCollectionById(input.id);
  const report = await classifyCollectionImport(collection, input.csvContent);
  const activeMembershipChanged =
    report.summary.toAddCount + report.summary.toReactivateCount + report.summary.toDeactivateCount > 0;

  const { versionId, invalidatedCurrentMembershipRuns, invalidatedHistoricalWeeks } = await db.transaction(
    async (tx) => {
      const [existingVersion] = await tx
        .select({ id: marketCollectionVersions.id })
        .from(marketCollectionVersions)
        .where(
          and(
            eq(marketCollectionVersions.collectionId, collection.id),
            eq(marketCollectionVersions.effectiveFrom, input.effectiveFrom)
          )
        );
      if (existingVersion) {
        throw conflict(
          `A membership version effective ${input.effectiveFrom} already exists for this collection. ` +
            "Use the version correction workflow to replace it instead of re-importing."
        );
      }

      for (const row of report.matched) {
        if (row.status === "already-active") continue;

        await tx
          .insert(marketCollectionMembers)
          .values({ collectionId: collection.id, instrumentId: row.instrumentId, active: true })
          .onConflictDoUpdate({
            target: [marketCollectionMembers.collectionId, marketCollectionMembers.instrumentId],
            set: { active: true, updatedAt: new Date() },
          });
      }

      for (const row of report.toDeactivate) {
        await tx
          .update(marketCollectionMembers)
          .set({ active: false, updatedAt: new Date() })
          .where(
            and(
              eq(marketCollectionMembers.collectionId, collection.id),
              eq(marketCollectionMembers.instrumentId, row.instrumentId)
            )
          );
      }

      await tx
        .update(marketCollections)
        .set({
          sourceName: input.sourceName ?? collection.sourceName,
          sourceDate: input.sourceDate ?? collection.sourceDate,
          lastImportedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(marketCollections.id, collection.id));

      // Phase D.5 #2 - current_membership lifecycle. current_membership
      // runs are documented as "whatever this collection's active set is
      // AT GENERATION TIME" - if this import actually changed the active
      // set, every already-persisted current_membership run now reflects
      // a DIFFERENT "current" than the collection has going forward.
      // Rather than let old and new weeks silently represent two
      // different universes under one series, invalidate the whole
      // current_membership series here so it can only ever be regenerated
      // as one coherent pass (the existing admin "Generate Backtest"
      // action - this does not auto-trigger a rebuild, matching how a
      // historical-membership rebuild is also always an explicit admin
      // action, and avoiding a slow synchronous rebuild inside this
      // request). historical_membership runs are untouched here - they
      // are keyed to point-in-time versions, not "now".
      let invalidatedCurrentMembershipRuns = 0;
      if (activeMembershipChanged) {
        const deletedCurrentRuns = await tx
          .delete(weeklyStrongBacktestRuns)
          .where(
            and(
              eq(weeklyStrongBacktestRuns.collectionId, collection.id),
              eq(weeklyStrongBacktestRuns.membershipMode, "current_membership")
            )
          )
          .returning({ id: weeklyStrongBacktestRuns.id });
        invalidatedCurrentMembershipRuns = deletedCurrentRuns.length;
      }

      // The version's member snapshot is exactly the uploaded file's full
      // matched symbol list (report.matched), regardless of each row's
      // new/reactivate/already-active status against the PREVIOUS active
      // set - that whole list is, by construction, the complete desired
      // membership as of effectiveFrom.
      const [version] = await tx
        .insert(marketCollectionVersions)
        .values({
          collectionId: collection.id,
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
            exchange: collection.exchange,
          }))
        );
      }

      // Phase D.5 #1 - new-version invalidation. This new version is now
      // authoritative for the window [effectiveFrom, next version's
      // effectiveFrom or unbounded). Any historical_membership run whose
      // weekEnding falls in that exact window was necessarily resolved
      // against a DIFFERENT (now-superseded) version for that week - it
      // predates this insert, so it cannot already be stamped with this
      // brand-new version's id. Delete it so the series is honest rather
      // than silently wrong; a "Rebuild Historical Backtest" regenerates
      // it. Scoped precisely to this window - weeks before effectiveFrom
      // and weeks at/after the next version's effectiveFrom (i.e. already
      // that later version's own territory) are untouched, and so are
      // other collections/versions.
      const [nextVersion] = await tx
        .select({ effectiveFrom: marketCollectionVersions.effectiveFrom })
        .from(marketCollectionVersions)
        .where(
          and(
            eq(marketCollectionVersions.collectionId, collection.id),
            gt(marketCollectionVersions.effectiveFrom, input.effectiveFrom)
          )
        )
        .orderBy(asc(marketCollectionVersions.effectiveFrom))
        .limit(1);

      const historicalWindowFilters = [
        eq(weeklyStrongBacktestRuns.collectionId, collection.id),
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

      return { versionId: version.id, invalidatedCurrentMembershipRuns, invalidatedHistoricalWeeks };
    }
  );

  invalidateCacheByPrefix("collections:list");
  invalidateCacheByPrefix(`collectionMembers:${collection.code}:`);
  invalidateCacheByPrefix(`collectionRelativeStrength:${collection.code}:`);
  invalidateCacheByPrefix(`collectionWeeklyStrongStocks:${collection.code}`);
  invalidateCacheByPrefix(`collectionWeeklyStrongBacktest:${collection.code}`);
  // Phase D.10 #5 - the AUTHORITATIVE invalidation for the persisted
  // snapshot (the in-process caches above are now just a short safety-net
  // layer on top of it, see COLLECTION_CACHE_TTL_MS). Membership changing
  // is exactly the kind of "underlying data actually changed" event the
  // report calls out - the next read of either metric type for this
  // collection recomputes once and re-persists.
  await invalidateCollectionSnapshots(collection.id);

  await audit(input.actorUserId, "market_collection.imported", "market_collection", collection.id, {
    summary: report.summary,
    effectiveFrom: input.effectiveFrom,
    versionId,
    invalidatedCurrentMembershipRuns,
    invalidatedHistoricalWeeks,
  });

  return {
    ...report,
    versionId,
    effectiveFrom: input.effectiveFrom,
    invalidatedCurrentMembershipRuns,
    invalidatedHistoricalWeeks,
  };
}

async function classifyCollectionImport(
  collection: { id: string; exchange: string },
  csvContent: string
): Promise<CollectionImportReport> {
  const { candidateSymbols, duplicates, invalid } = parseCollectionCsv(csvContent);

  const instrumentRows =
    candidateSymbols.length > 0
      ? await db
          .select({ id: instruments.id, symbol: instruments.symbol })
          .from(instruments)
          .where(
            and(eq(instruments.exchange, collection.exchange), inArray(instruments.symbol, candidateSymbols))
          )
      : [];
  const instrumentIdBySymbol = new Map(instrumentRows.map((row) => [row.symbol, row.id]));
  const unmatched = candidateSymbols.filter((symbol) => !instrumentIdBySymbol.has(symbol));

  const currentMembers = await db
    .select({
      instrumentId: marketCollectionMembers.instrumentId,
      symbol: instruments.symbol,
      active: marketCollectionMembers.active,
    })
    .from(marketCollectionMembers)
    .innerJoin(instruments, eq(marketCollectionMembers.instrumentId, instruments.id))
    .where(eq(marketCollectionMembers.collectionId, collection.id));
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

// Accepts a bare newline list of symbols, a simple single-column CSV with a
// "symbol" header, or NSE's own official index-constituent CSV export
// (e.g. "ind_nifty100list.csv": Company Name, Industry, Symbol, Series,
// ISIN Code — Symbol isn't the first column there). If the header row has a
// column literally named "symbol", that column is used; otherwise the
// first comma-separated field on each line is treated as the symbol.
// Symbols must look like a plausible equity ticker; anything that doesn't
// match is reported as invalid rather than silently dropped. Exported for
// market-collection-versions.service.ts's replace/correction workflow,
// which reuses the exact same parsing rules rather than a second parser.
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

// Exported for weekly-strong-backtest.service.ts's own admin (by id) and
// public (by code) collection lookups - same active/404 rules, not
// reimplemented there.
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

// Exported for market-collection-versions.service.ts (same audit_logs
// table, same shape - not reimplemented there).
export async function audit(
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
