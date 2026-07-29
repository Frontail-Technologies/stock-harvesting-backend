import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { auditLogs, instruments, marketCollectionMembers, marketCollections } from "../../db/schema";
import { getOrSetCache, invalidateCacheByPrefix } from "../../shared/cache";
import { conflict, notFound } from "../../shared/errors";
import { normalizeSymbol } from "../../shared/normalize";
import {
  computeRelativeStrengthMetrics,
  computeWeeklyStrongStocks,
  computeWeeklyStrongStocksBacktest,
  NSE_NORMAL_EQUITY_SYMBOL_PATTERN,
} from "../market-data/market-data.service";

const COLLECTION_CACHE_TTL_MS = 30_000;
// The backtest re-runs the breakout screen across ~150 historical weeks per
// member, so it's meaningfully more expensive than the other cached lookups
// above — cache it for longer since it only changes with new EOD data.
const COLLECTION_BACKTEST_CACHE_TTL_MS = 60 * 60_000;

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

export async function listCollections(input: { exchange?: string }) {
  const filters = [
    eq(marketCollections.active, true),
    input.exchange ? eq(marketCollections.exchange, input.exchange) : undefined,
  ].filter(Boolean);

  return db
    .select({
      id: marketCollections.id,
      code: marketCollections.code,
      name: marketCollections.name,
      exchange: marketCollections.exchange,
      memberCount: sql<number>`(
        select count(*)::int from ${marketCollectionMembers}
        where ${marketCollectionMembers.collectionId} = ${marketCollections.id}
        and ${marketCollectionMembers.active} = true
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

export async function getCollectionRelativeStrength(input: { code: string; limit: number }) {
  const collection = await requireCollectionByCode(input.code);
  const cacheKey = `collectionRelativeStrength:${collection.code}:${input.limit}`;

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const metrics = await computeRelativeStrengthMetrics(memberRows, collection.exchange, input.limit);
    return {
      collection: { code: collection.code, name: collection.name },
      metrics,
    };
  });
}

// ChartInk-style "within 15% of its own multi-year closing high" breakout
// screen, scoped to this collection's active members.
export async function getCollectionWeeklyStrongStocks(input: { code: string }) {
  const collection = await requireCollectionByCode(input.code);
  const cacheKey = `collectionWeeklyStrongStocks:${collection.code}`;

  return getOrSetCache(cacheKey, COLLECTION_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const items = await computeWeeklyStrongStocks(memberRows, collection.exchange);
    return {
      collection: { code: collection.code, name: collection.name },
      items,
    };
  });
}

export async function getCollectionWeeklyStrongStocksBacktest(input: { code: string; weeks?: number }) {
  const collection = await requireCollectionByCode(input.code);
  const weeks = input.weeks ?? 156;
  const cacheKey = `collectionWeeklyStrongBacktest:${collection.code}:${weeks}`;

  return getOrSetCache(cacheKey, COLLECTION_BACKTEST_CACHE_TTL_MS, async () => {
    const memberRows = await getActiveMemberInstrumentRows(collection.id);
    const points = await computeWeeklyStrongStocksBacktest(memberRows, collection.exchange, weeks);
    return {
      collection: { code: collection.code, name: collection.name },
      points,
    };
  });
}

async function getActiveMemberInstrumentRows(collectionId: string) {
  return db
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
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

export async function importCollectionCsv(input: {
  id: string;
  csvContent: string;
  sourceName?: string;
  sourceDate?: string;
  actorUserId: string;
}) {
  const collection = await requireCollectionById(input.id);
  const report = await classifyCollectionImport(collection, input.csvContent);

  await db.transaction(async (tx) => {
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
  });

  invalidateCacheByPrefix("collections:list");
  invalidateCacheByPrefix(`collectionMembers:${collection.code}:`);
  invalidateCacheByPrefix(`collectionRelativeStrength:${collection.code}:`);
  invalidateCacheByPrefix(`collectionWeeklyStrongStocks:${collection.code}`);
  invalidateCacheByPrefix(`collectionWeeklyStrongBacktest:${collection.code}`);

  await audit(input.actorUserId, "market_collection.imported", "market_collection", collection.id, {
    summary: report.summary,
  });

  return report;
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
// match is reported as invalid rather than silently dropped.
function parseCollectionCsv(csvContent: string) {
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

async function requireCollectionById(id: string) {
  const [collection] = await db.select().from(marketCollections).where(eq(marketCollections.id, id));
  if (!collection) throw notFound("Collection not found");
  return collection;
}

async function requireCollectionByCode(code: string) {
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
