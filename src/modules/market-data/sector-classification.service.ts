import { sql } from "drizzle-orm";

import { db } from "../../db/client";
import { marketCollectionMembers, marketCollections } from "../../db/schema";
import { normalizeSymbol } from "../../shared/normalize";
import {
  fetchSectoralClassificationBySector,
  fetchSectors,
} from "../data-provider/adapters/global-datafeeds-fundamentals/global-datafeeds-fundamentals.client";

export type SectorClassificationSyncResult = {
  sectorsProcessed: number;
  companiesSeen: number;
  companiesMatched: number;
  bseCollectionMembers: number;
};

const CLASSIFICATION_UPDATE_CHUNK_SIZE = 500;
const COLLECTION_MEMBER_UPSERT_CHUNK_SIZE = 500;

// The Fundamentals API itself is fixed to BSE (GLOBAL_DATAFEEDS_FUNDAMENTALS_EXCHANGE),
// so every classified company this sync sees is a real BSE listing — this
// collection lets the dashboard group/rank them without anyone preparing a
// CSV, the way NSE collections (NIFTY 50, ...) require today.
const AUTO_COLLECTION_CODE = "BSE-CLASSIFIED";
const AUTO_COLLECTION_NAME = "BSE — Classified Universe";
const AUTO_COLLECTION_EXCHANGE = "BSE";

type ClassificationRow = {
  symbol: string;
  sector: string;
  sectorCode: string | null;
  industry: string;
  industryCode: string | null;
};

// GlobalDataFeeds' Fundamentals API has no bulk "everything" endpoint, but
// GetSectoralClassification?sector=X returns every company in that sector in
// one call (confirmed live: ~300-750 rows per sector) — so the whole ~22-way
// sector taxonomy covers every classified company in ~22 requests, nowhere
// close to the 900/hour rate limit. Matching back onto our own `instruments`
// rows is by normalized symbol only — we don't have ISIN on our side (Zerodha's
// raw instrument dump doesn't include it), and neither company nor exchange
// codes overlap directly with our schema.
//
// The DB side runs as a single bulk `UPDATE ... FROM (VALUES ...)` per chunk
// rather than one UPDATE per company — with several thousand companies across
// all sectors, one-row-at-a-time updates take minutes; this takes seconds.
export async function syncSectorClassifications(): Promise<SectorClassificationSyncResult> {
  const sectors = await fetchSectors();
  const classificationBySymbol = new Map<string, ClassificationRow>();

  for (const sector of sectors) {
    const rows = await fetchSectoralClassificationBySector(sector.name);

    for (const row of rows) {
      if (!row.Symbol || !row.Sector || !row.Industry) continue;

      classificationBySymbol.set(normalizeSymbol(row.Symbol), {
        symbol: normalizeSymbol(row.Symbol),
        sector: row.Sector,
        sectorCode: row.SectCode ?? null,
        industry: row.Industry,
        industryCode: row.IndustryCode ?? null,
      });
    }
  }

  const rows = [...classificationBySymbol.values()];
  const { matched, bseInstrumentIds } = await bulkUpdateClassification(rows);

  const bseCollectionMembers = await syncAutoBseCollection(bseInstrumentIds);

  return {
    sectorsProcessed: sectors.length,
    companiesSeen: rows.length,
    companiesMatched: matched,
    bseCollectionMembers,
  };
}

async function bulkUpdateClassification(rows: ClassificationRow[]) {
  let matched = 0;
  const bseInstrumentIds: string[] = [];

  for (let index = 0; index < rows.length; index += CLASSIFICATION_UPDATE_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + CLASSIFICATION_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const values = sql.join(
      chunk.map(
        (row) =>
          sql`(${row.symbol}, ${row.sector}, ${row.sectorCode}, ${row.industry}, ${row.industryCode})`
      ),
      sql`, `
    );

    // Scoped to India exchanges only — this classification data is BSE's own
    // issuer database, and ticker symbols collide across unrelated companies
    // on other exchanges (confirmed live: "TCS" also matches unrelated
    // US/Toronto/Stuttgart-listed tickers). Applying it without this filter
    // silently mislabels those rows with Tata Consultancy Services' sector.
    //
    // RETURNING id/exchange so the BSE-specific matches (not NSE — the same
    // symbol can legitimately match both, for dual-listed companies) can be
    // fed into the auto-collection below without a second query.
    const result = await db.execute<{ id: string; exchange: string }>(sql`
      UPDATE instruments AS i
      SET
        sector = v.sector,
        sector_code = v.sector_code,
        industry = v.industry,
        industry_code = v.industry_code,
        classification_synced_at = now()
      FROM (VALUES ${values}) AS v(symbol, sector, sector_code, industry, industry_code)
      WHERE i.symbol = v.symbol AND i.exchange IN ('NSE', 'BSE')
      RETURNING i.id AS id, i.exchange AS exchange
    `);

    matched += result.rows.length;
    for (const row of result.rows) {
      if (row.exchange === AUTO_COLLECTION_EXCHANGE) bseInstrumentIds.push(row.id);
    }
  }

  return { matched, bseInstrumentIds };
}

// Auto-creates (once) and repopulates the flat "BSE — Classified Universe"
// collection from whichever BSE instruments this sync just classified —
// the same mechanism NIFTY 50 etc. rely on for grouping/ranking, just
// populated from the Fundamentals API instead of an admin-imported CSV.
async function syncAutoBseCollection(instrumentIds: string[]) {
  const uniqueIds = [...new Set(instrumentIds)];
  if (uniqueIds.length === 0) return 0;

  const [collection] = await db
    .insert(marketCollections)
    .values({
      code: AUTO_COLLECTION_CODE,
      name: AUTO_COLLECTION_NAME,
      exchange: AUTO_COLLECTION_EXCHANGE,
      description:
        "Auto-populated from GlobalDataFeeds Fundamentals sector/industry classification. Not CSV-imported — regenerated on every Sync Sector Data run.",
      active: true,
    })
    .onConflictDoUpdate({
      target: [marketCollections.exchange, marketCollections.code],
      set: { updatedAt: new Date() },
    })
    .returning();

  if (!collection) return 0;

  let memberCount = 0;
  for (
    let index = 0;
    index < uniqueIds.length;
    index += COLLECTION_MEMBER_UPSERT_CHUNK_SIZE
  ) {
    const chunk = uniqueIds.slice(index, index + COLLECTION_MEMBER_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    await db
      .insert(marketCollectionMembers)
      .values(
        chunk.map((instrumentId) => ({
          collectionId: collection.id,
          instrumentId,
          active: true,
        }))
      )
      .onConflictDoUpdate({
        target: [marketCollectionMembers.collectionId, marketCollectionMembers.instrumentId],
        set: { active: true, updatedAt: new Date() },
      });

    memberCount += chunk.length;
  }

  return memberCount;
}
