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

// Pure point-in-time decision (see market-collection-versions.test.ts):
// among a collection's versions, picks the one with the latest
// effectiveFrom that is still <= asOfDate, or null if none qualify - never
// a silent fallback to some other version.
//
// Not used by the single-lookup path below (getCollectionMembershipAt) -
// that stays a single server-side WHERE+ORDER+LIMIT(1) query, strictly
// cheaper than fetching every version for one date. This powers the BATCH
// resolver instead (resolveMembershipVersionsForDates), which fetches a
// collection's full version list once and resolves many dates against it
// in memory rather than one query per date.
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
  // sector/industry are joined live from `instruments` (best current
  // classification, deliberately not frozen at import time), matching how
  // getActiveMemberInstrumentRows joins for the current_membership path.
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

// dbClient defaults to the real db so real callers are unaffected; it
// exists to make this testable against a fake client.
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

// Batch form for the historical rebuild: resolves the applicable version
// (and members) for several dates without one query per date. Fetches a
// collection's version list once (always small) via selectApplicableVersion,
// then fetches member rows once per distinct resolved version, since many
// dates commonly resolve to the same version.
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
  // Rows are newest-first: the first with effectiveFrom <= today is
  // "current" (same selection getCollectionMembershipAt makes for today);
  // rows before it are "scheduled" (future), after it are "superseded".
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
// Explicit replace/correction workflow - the only sanctioned way to
// change an already-created version's member list. effectiveFrom is never
// editable here: a correction fixes what the list *was*, not when it took
// effect.
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

  // Weeks evaluated against this version's old member list are now wrong -
  // delete those historical_membership runs (members cascade via runId)
  // rather than leave stale data. Scoped to just this version; not an
  // automatic recompute - admin must re-run "Rebuild Historical Backtest".
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
