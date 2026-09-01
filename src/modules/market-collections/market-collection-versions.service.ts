import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import {
  instruments,
  marketCollectionVersionMembers,
  marketCollectionVersions,
  weeklyStrongBacktestRuns,
} from "../../db/schema";
import { notFound } from "../../shared/errors";
import { audit, parseCollectionCsv, requireCollectionById } from "./market-collections.service";

// ---------------------------------------------------------------------
// THE canonical point-in-time membership resolver. Every
// historical backtest path - rebuild, incremental - calls this, never
// re-derives "which version applies" independently.
// ---------------------------------------------------------------------

export type CollectionMembershipMember = {
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
};

export type CollectionMembershipAt = {
  versionId: string;
  effectiveFrom: string;
  members: CollectionMembershipMember[];
};

export type CollectionVersionEffectiveFromRow = { id: string; effectiveFrom: string };

// The point-in-time decision as a pure function, directly unit-testable
// (see market-collection-versions.test.ts) without a live database: among
// versions belonging to one collection, pick the one with the latest
// effectiveFrom that is still <= asOfDate. Returns null - never falling
// back to some other version - when asOfDate predates every available
// version's effectiveFrom, never a silent current-membership fallback.
//
// NOT used by the single-lookup path below (getCollectionMembershipAt) -
// that stays a single, efficient, server-side WHERE+ORDER+LIMIT(1) query,
// since Postgres doing that comparison is strictly better than fetching
// every version and comparing in JS for a single date. This function's
// real production caller is the BATCH resolver further down
// (resolveMembershipVersionsForDates), which genuinely benefits from
// fetching a collection's full version list ONCE (always small - a
// handful over a collection's lifetime, never thousands) and then
// resolving up to 250 dates against it in memory, instead of running the
// single-lookup query up to 250 times.
export function selectApplicableVersion(
  versions: CollectionVersionEffectiveFromRow[],
  asOfDate: string
): CollectionVersionEffectiveFromRow | null {
  let best: CollectionVersionEffectiveFromRow | null = null;
  for (const version of versions) {
    if (version.effectiveFrom > asOfDate) continue;
    if (!best || version.effectiveFrom > best.effectiveFrom) best = version;
  }
  return best;
}

async function fetchMembersForVersion(
  version: CollectionVersionEffectiveFromRow,
  dbClient: DbOrTx
): Promise<CollectionMembershipAt> {
  // sector/industry are joined live from `instruments` - "best current
  // classification knowledge" - deliberately not frozen at import time
  // (see the schema file's own comment). This mirrors exactly how
  // getActiveMemberInstrumentRows already joins instruments for the
  // current_membership path, so a historical run's sector grouping is
  // computed the same way a current run's is.
  const members = await dbClient
    .select({
      instrumentId: marketCollectionVersionMembers.instrumentId,
      symbol: marketCollectionVersionMembers.symbol,
      exchange: marketCollectionVersionMembers.exchange,
      name: instruments.name,
      sector: instruments.sector,
      industry: instruments.industry,
    })
    .from(marketCollectionVersionMembers)
    .innerJoin(instruments, eq(marketCollectionVersionMembers.instrumentId, instruments.id))
    .where(eq(marketCollectionVersionMembers.versionId, version.id));

  return { versionId: version.id, effectiveFrom: version.effectiveFrom, members };
}

// dbClient defaults to the real db - every real caller gets identical
// behavior to before this parameter existed. It exists so this function's
// members-join query is directly testable with a fake client, the same
// tiny-seam pattern replaceCandlesAtomically already uses in
// market-data.service.ts.
export async function getCollectionMembershipAt(
  collectionId: string,
  asOfDate: string,
  dbClient: DbOrTx = db
): Promise<CollectionMembershipAt | null> {
  const [version] = await dbClient
    .select({
      id: marketCollectionVersions.id,
      effectiveFrom: marketCollectionVersions.effectiveFrom,
    })
    .from(marketCollectionVersions)
    .where(
      and(
        eq(marketCollectionVersions.collectionId, collectionId),
        lte(marketCollectionVersions.effectiveFrom, asOfDate)
      )
    )
    .orderBy(desc(marketCollectionVersions.effectiveFrom))
    .limit(1);

  if (!version) return null;

  return fetchMembersForVersion(version, dbClient);
}

// Batch form for the historical rebuild: given several distinct dates,
// resolves the applicable version (and its full members) for each one, so
// the rebuild service can group weeks by resolved version without one
// query per week. Unlike getCollectionMembershipAt, this DOES fetch every
// version for the collection up front (always small - a handful over a
// collection's lifetime) via selectApplicableVersion, since resolving up
// to 250 dates one-SQL-query-at-a-time would be up to 250 round trips
// against the same small version set. Member rows are then fetched once
// per DISTINCT resolved version (not once per date), since many dates
// commonly resolve to the same version.
export async function resolveMembershipVersionsForDates(
  collectionId: string,
  asOfDates: string[],
  dbClient: DbOrTx = db
): Promise<Map<string, CollectionMembershipAt | null>> {
  const uniqueDates = [...new Set(asOfDates)];
  const result = new Map<string, CollectionMembershipAt | null>();
  if (uniqueDates.length === 0) return result;

  const allVersions = await dbClient
    .select({
      id: marketCollectionVersions.id,
      effectiveFrom: marketCollectionVersions.effectiveFrom,
    })
    .from(marketCollectionVersions)
    .where(eq(marketCollectionVersions.collectionId, collectionId));

  const resolvedByDate = new Map<string, CollectionVersionEffectiveFromRow | null>();
  for (const date of uniqueDates) {
    resolvedByDate.set(date, selectApplicableVersion(allVersions, date));
  }

  const membershipByVersionId = new Map<string, CollectionMembershipAt>();
  for (const version of resolvedByDate.values()) {
    if (!version || membershipByVersionId.has(version.id)) continue;
    membershipByVersionId.set(version.id, await fetchMembersForVersion(version, dbClient));
  }

  for (const date of uniqueDates) {
    const version = resolvedByDate.get(date);
    result.set(date, version ? (membershipByVersionId.get(version.id) ?? null) : null);
  }

  return result;
}

// ---------------------------------------------------------------------
// Admin version history
// ---------------------------------------------------------------------

export type CollectionVersionSummary = {
  id: string;
  effectiveFrom: string;
  memberCount: number;
  sourceName: string | null;
  sourceDate: string | null;
  importedAt: string;
  status: "current" | "superseded" | "scheduled";
};

export async function listCollectionVersions(collectionId: string): Promise<CollectionVersionSummary[]> {
  await requireCollectionById(collectionId);

  const rows = await db
    .select({
      id: marketCollectionVersions.id,
      effectiveFrom: marketCollectionVersions.effectiveFrom,
      memberCount: marketCollectionVersions.memberCount,
      sourceName: marketCollectionVersions.sourceName,
      sourceDate: marketCollectionVersions.sourceDate,
      importedAt: marketCollectionVersions.importedAt,
    })
    .from(marketCollectionVersions)
    .where(eq(marketCollectionVersions.collectionId, collectionId))
    .orderBy(desc(marketCollectionVersions.effectiveFrom));

  const todayIso = new Date().toISOString().slice(0, 10);
  // Rows are newest-first. The first row whose effectiveFrom <= today is
  // "current" (the exact same selection getCollectionMembershipAt would
  // make for asOfDate = today); everything before it in this order has a
  // future effectiveFrom ("scheduled"); everything after it is
  // "superseded".
  const currentIndex = rows.findIndex((row) => row.effectiveFrom <= todayIso);

  return rows.map((row, index) => ({
    ...row,
    importedAt: row.importedAt.toISOString(),
    status:
      currentIndex === -1 || index < currentIndex
        ? "scheduled"
        : index === currentIndex
          ? "current"
          : "superseded",
  }));
}

export async function getCollectionVersionMembers(collectionId: string, versionId: string) {
  await requireCollectionById(collectionId);

  const [version] = await db
    .select()
    .from(marketCollectionVersions)
    .where(and(eq(marketCollectionVersions.id, versionId), eq(marketCollectionVersions.collectionId, collectionId)));
  if (!version) throw notFound("Membership version not found");

  const members = await db
    .select({
      instrumentId: marketCollectionVersionMembers.instrumentId,
      symbol: marketCollectionVersionMembers.symbol,
      exchange: marketCollectionVersionMembers.exchange,
      name: instruments.name,
    })
    .from(marketCollectionVersionMembers)
    .innerJoin(instruments, eq(marketCollectionVersionMembers.instrumentId, instruments.id))
    .where(eq(marketCollectionVersionMembers.versionId, versionId))
    .orderBy(asc(marketCollectionVersionMembers.symbol));

  return {
    version: {
      id: version.id,
      effectiveFrom: version.effectiveFrom,
      memberCount: version.memberCount,
      sourceName: version.sourceName,
      sourceDate: version.sourceDate,
      importedAt: version.importedAt.toISOString(),
    },
    members,
  };
}

// ---------------------------------------------------------------------
// Explicit replace/correction workflow - the ONLY sanctioned
// way to change an already-created version's member list. Never called
// implicitly by a normal upload (importCollectionCsv rejects re-use of an
// existing effectiveFrom instead - see market-collections.service.ts).
// effectiveFrom itself is never editable here, by design: a correction
// fixes what the constituent list *was*, not when it took effect.
// ---------------------------------------------------------------------

export async function replaceCollectionVersionMembers(input: {
  collectionId: string;
  versionId: string;
  csvContent: string;
  actorUserId: string;
}) {
  const collection = await requireCollectionById(input.collectionId);

  const [version] = await db
    .select()
    .from(marketCollectionVersions)
    .where(
      and(eq(marketCollectionVersions.id, input.versionId), eq(marketCollectionVersions.collectionId, collection.id))
    );
  if (!version) throw notFound("Membership version not found");

  const { candidateSymbols, invalid } = parseCollectionCsv(input.csvContent);
  const instrumentRows =
    candidateSymbols.length > 0
      ? await db
          .select({ id: instruments.id, symbol: instruments.symbol })
          .from(instruments)
          .where(and(eq(instruments.exchange, collection.exchange), inArray(instruments.symbol, candidateSymbols)))
      : [];
  const instrumentIdBySymbol = new Map(instrumentRows.map((row) => [row.symbol, row.id]));
  const unmatched = candidateSymbols.filter((symbol) => !instrumentIdBySymbol.has(symbol));
  const matchedSymbols = candidateSymbols.filter((symbol) => instrumentIdBySymbol.has(symbol));

  // Weeks that were evaluated against this version's OLD member list are
  // now wrong - safeguard: delete those historical_membership runs (their
  // own members cascade with them via runId) rather than leave stale/
  // incorrect data on the Dashboard. This is a targeted invalidation
  // scoped to exactly this version - rebuilding only the necessary
  // historical range, never blindly recomputing every collection - and
  // not an automatic recompute either: admin must explicitly re-run "Rebuild
  // Historical Backtest" afterward to regenerate these weeks.
  const affectedRuns = await db
    .select({ weekEnding: weeklyStrongBacktestRuns.weekEnding })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collection.id),
        eq(weeklyStrongBacktestRuns.membershipVersionId, version.id)
      )
    );

  await db.transaction(async (tx) => {
    await tx.delete(marketCollectionVersionMembers).where(eq(marketCollectionVersionMembers.versionId, version.id));

    if (matchedSymbols.length > 0) {
      await tx.insert(marketCollectionVersionMembers).values(
        matchedSymbols.map((symbol) => ({
          versionId: version.id,
          instrumentId: instrumentIdBySymbol.get(symbol) as string,
          symbol,
          exchange: collection.exchange,
        }))
      );
    }

    await tx
      .update(marketCollectionVersions)
      .set({ memberCount: matchedSymbols.length })
      .where(eq(marketCollectionVersions.id, version.id));

    await tx
      .delete(weeklyStrongBacktestRuns)
      .where(
        and(
          eq(weeklyStrongBacktestRuns.collectionId, collection.id),
          eq(weeklyStrongBacktestRuns.membershipVersionId, version.id)
        )
      );
  });

  await audit(input.actorUserId, "market_collection_version.replaced", "market_collection_version", version.id, {
    memberCount: matchedSymbols.length,
    unmatchedCount: unmatched.length,
    invalidCount: invalid.length,
    invalidatedWeeks: affectedRuns.map((run) => run.weekEnding),
  });

  return {
    versionId: version.id,
    memberCount: matchedSymbols.length,
    unmatched,
    invalid,
    invalidatedWeeks: affectedRuns.map((run) => run.weekEnding),
  };
}
