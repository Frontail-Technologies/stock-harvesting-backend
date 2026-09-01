import { and, eq, inArray, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { instruments } from "../../db/schema";
import { CANDLE_TIMEFRAME, DEFAULT_EXCHANGE } from "../../shared/constants";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import {
  getDataProviderAdapterForExchange,
  getEligibleProviderAdapter,
} from "../data-provider/data-provider.service";

// Instrument-table DB operations (lookup, fallback creation, bulk upsert,
// latest-stats writes) that don't need provider-search/backfill
// orchestration. getOrCreateInstrument lives in market-data.instrument-sync.ts
// instead of here because it falls back to ensureInstrumentsForSymbols
// (a provider-orchestration function) on a miss.

const INSTRUMENT_UPSERT_CHUNK_SIZE = 500;
// 6 params/row (symbol + 5 stat columns; updatedAt uses now(), not a
// per-row param) x 500 = 3,000 params/statement - comfortably under
// Postgres's 65,535-parameter protocol limit, matching every other bulk
// chunk size already used in this file/module (CANDLE_UPSERT_CHUNK_SIZE,
// INSTRUMENT_UPSERT_CHUNK_SIZE, sector-classification.service.ts's
// CLASSIFICATION_UPDATE_CHUNK_SIZE).
const INSTRUMENT_STATS_UPDATE_CHUNK_SIZE = 500;

export async function getInstrumentsBySymbol(symbols: string[], exchange: string = DEFAULT_EXCHANGE) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  if (uniqueSymbols.length === 0) return new Map<string, typeof instruments.$inferSelect>();

  const rows = await db
    .select()
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), inArray(instruments.symbol, uniqueSymbols)));

  return new Map(rows.map((row) => [row.symbol, row]));
}

export async function createFallbackInstrument(symbol: string, exchange: string = DEFAULT_EXCHANGE) {
  const normalizedSymbol = normalizeSymbol(symbol);
  // Tagging (which provider's instrument-token format this row uses) is
  // separate from "which provider may we actually call right now" - the
  // static registry mapping is fine for the tag even when the provider is
  // currently disabled, but the token itself is only ever fetched from an
  // eligible adapter.
  const staticAdapter = getDataProviderAdapterForExchange(exchange);
  const eligibleAdapter = await getEligibleProviderAdapter({
    exchange,
    capability: "instrument_token",
  });
  const instrumentToken = eligibleAdapter?.getInstrumentToken
    ? await eligibleAdapter.getInstrumentToken(normalizedSymbol, exchange)
    : normalizedSymbol;
  const [instrument] = await db
    .insert(instruments)
    .values({
      provider: staticAdapter.providerKey,
      exchange,
      symbol: normalizedSymbol,
      name: normalizedSymbol,
      instrumentToken,
      active: true,
    })
    .onConflictDoUpdate({
      target: [instruments.exchange, instruments.symbol],
      set: {
        provider: staticAdapter.providerKey,
        active: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  return instrument;
}

export async function upsertInstrument(instrument: {
  exchange: string;
  symbol: string;
  name: string;
  instrumentToken: string;
  segment?: string;
}) {
  const adapter = getDataProviderAdapterForExchange(instrument.exchange);
  await upsertInstruments([instrument], adapter.providerKey);
}

export type InstrumentUpsertInput = {
  exchange: string;
  symbol: string;
  name: string;
  instrumentToken: string;
  segment?: string;
};

// `instruments` enforces two unique constraints - (exchange, symbol) and
// (provider, instrument_token) - but onConflictDoUpdate below can only
// target one of them. A batch containing two rows that collide on *either*
// key fails the whole INSERT with "ON CONFLICT DO UPDATE command cannot
// affect row a second time" (exchange+symbol) or a duplicate-key violation
// (instrument_token), even though only one row actually collides. This
// applies both dedup passes before the insert ever runs.
//
// Conflict resolution is deterministic: the later row in `inputs` wins,
// matching dedupeCandleUpsertInputs' existing "last write wins" rule.
// Symbol-level duplicates are resolved first (using the exchange+symbol
// identity the ON CONFLICT target relies on), then token-level duplicates
// are resolved among those survivors - so a genuine vendor anomaly (two
// different symbols claiming the same instrument token) drops the earlier
// symbol's row from *this* sync rather than failing the batch; it picks up
// on the next successful sync once the vendor data is consistent again.
export function dedupeInstrumentUpsertInputs(inputs: InstrumentUpsertInput[]) {
  const bySymbolKey = new Map<string, InstrumentUpsertInput>();
  for (const row of inputs) {
    bySymbolKey.set(`${row.exchange}:${normalizeSymbol(row.symbol)}`, row);
  }

  const byToken = new Map<string, InstrumentUpsertInput>();
  for (const row of bySymbolKey.values()) {
    byToken.set(row.instrumentToken, row);
  }

  const deduped = [...byToken.values()];
  const droppedCount = inputs.length - deduped.length;
  if (droppedCount > 0) {
    logger.warn(
      { inputCount: inputs.length, dedupedCount: deduped.length, droppedCount },
      "Dropped duplicate instrument rows within a single sync batch"
    );
  }

  return deduped;
}

// dedupeInstrumentUpsertInputs above only catches collisions within *this*
// batch. A row can still collide with a *different* (exchange, symbol) row
// already sitting in the DB from an earlier sync - e.g. a provider reusing
// an instrument_token across two segments - which the ON CONFLICT target
// (exchange, symbol) doesn't cover, since it never matches an existing row
// for a brand-new symbol and falls through to a plain INSERT that then
// fails the separate (provider, instrument_token) unique constraint. Drop
// those here rather than letting a handful of vendor-anomaly rows abort an
// entire sync batch.
async function dropCrossBatchTokenCollisions(
  inputs: InstrumentUpsertInput[],
  provider: string,
  dbClient: DbOrTx
) {
  if (inputs.length === 0) return inputs;

  const tokens = inputs.map((row) => row.instrumentToken);
  const existingRows = await dbClient
    .select({
      exchange: instruments.exchange,
      symbol: instruments.symbol,
      instrumentToken: instruments.instrumentToken,
    })
    .from(instruments)
    .where(and(eq(instruments.provider, provider), inArray(instruments.instrumentToken, tokens)));

  const existingByToken = new Map(existingRows.map((row) => [row.instrumentToken, row]));
  const kept: InstrumentUpsertInput[] = [];
  let droppedCount = 0;

  for (const row of inputs) {
    const existing = existingByToken.get(row.instrumentToken);
    const isSameIdentity =
      existing && existing.exchange === row.exchange && existing.symbol === normalizeSymbol(row.symbol);
    if (existing && !isSameIdentity) {
      droppedCount++;
      continue;
    }
    kept.push(row);
  }

  if (droppedCount > 0) {
    logger.warn(
      { provider, droppedCount },
      "Dropped instrument rows whose token already belongs to a different symbol in the DB"
    );
  }

  return kept;
}

export async function upsertInstruments(input: InstrumentUpsertInput[], provider: string, dbClient: DbOrTx = db) {
  const dedupedInput = await dropCrossBatchTokenCollisions(
    dedupeInstrumentUpsertInputs(input),
    provider,
    dbClient
  );

  for (let index = 0; index < dedupedInput.length; index += INSTRUMENT_UPSERT_CHUNK_SIZE) {
    const chunk = dedupedInput.slice(index, index + INSTRUMENT_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    await dbClient
      .insert(instruments)
      .values(
        chunk.map((instrument) => ({
          provider,
          exchange: instrument.exchange,
          symbol: normalizeSymbol(instrument.symbol),
          name: instrument.name,
          instrumentToken: instrument.instrumentToken,
          segment: instrument.segment,
          active: true,
        }))
      )
      .onConflictDoUpdate({
        target: [instruments.exchange, instruments.symbol],
        set: {
          provider,
          name: sql`excluded.name`,
          instrumentToken: sql`excluded.instrument_token`,
          segment: sql`excluded.segment`,
          active: true,
          updatedAt: new Date(),
        },
      });
  }
}

type LatestStockStatsRow = {
  symbol: string;
  open: string;
  close: string;
  volume: string;
  time: string;
};

// Old query (kept here only as the EXPLAIN comparison baseline - no longer
// called): `SELECT ... FROM candles WHERE exchange=? AND timeframe='1D' AND
// symbol IN (...) ORDER BY symbol, time DESC` with no LIMIT - Postgres has
// no way to know only 2 rows per symbol are wanted, so it returns every
// matching daily candle ever stored for every requested symbol.
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT symbol, open, close, volume, time FROM candles
//   WHERE exchange = 'NSE' AND timeframe = '1D' AND symbol = ANY(ARRAY['RELIANCE','TCS'])
//   ORDER BY symbol, time DESC;
//   -- healthy-looking plan, but "rows" here is every historical row per
//   -- symbol (thousands for a multi-year backfill), not the 2 actually used:
//   --   Index Scan using candles_exchange_symbol_timeframe_time_unique on candles
//   --     Index Cond: (exchange = 'NSE' AND symbol = ANY(...) AND timeframe = '1D')
//
// New query below asks Postgres for exactly the top-2-per-symbol instead,
// via a window function filtered in an outer query (row_number() can't be
// filtered directly in WHERE):
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT symbol, open, close, volume, time FROM (
//     SELECT symbol, open, close, volume, time,
//            row_number() OVER (PARTITION BY symbol ORDER BY time DESC) AS rn
//     FROM candles
//     WHERE exchange = 'NSE' AND timeframe = '1D' AND symbol = ANY(ARRAY['RELIANCE','TCS'])
//   ) ranked WHERE rn <= 2 ORDER BY symbol, time DESC;
//   -- same Index Scan for the inner scan, but WindowAgg + an rn<=2 filter
//   -- caps actual rows returned to the client at 2 per symbol instead of
//   -- the symbol's entire stored history.
// (Both plans reference the existing composite unique index - this is a
// query-shape fix, not an indexing fix.)
async function getLatestStockStats(symbols: string[], exchange: string = DEFAULT_EXCHANGE, dbClient: DbOrTx = db) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  const stats = new Map<
    string,
    { close: number; open: number; volume: number; changePct: number | null; time: string }
  >();

  if (uniqueSymbols.length === 0) return stats;

  const startedAt = Date.now();
  const result = await dbClient.execute<LatestStockStatsRow>(sql`
    SELECT symbol, open, close, volume, time::text AS time FROM (
      SELECT
        symbol, open, close, volume, time,
        row_number() OVER (PARTITION BY symbol ORDER BY time DESC) AS rn
      FROM candles
      WHERE exchange = ${exchange}
        AND timeframe = ${CANDLE_TIMEFRAME.day}
        AND symbol = ANY(ARRAY[${sql.join(uniqueSymbols.map((symbol) => sql`${symbol}`), sql`, `)}]::text[])
    ) ranked
    WHERE rn <= 2
    ORDER BY symbol, time DESC
  `);
  logger.debug(
    {
      exchange,
      symbolCount: uniqueSymbols.length,
      rowCount: result.rows.length,
      durationMs: Date.now() - startedAt,
    },
    "getLatestStockStats query"
  );

  const recentRowsBySymbol = new Map<string, LatestStockStatsRow[]>();
  for (const row of result.rows) {
    const currentRows = recentRowsBySymbol.get(row.symbol) ?? [];
    currentRows.push(row);
    recentRowsBySymbol.set(row.symbol, currentRows);
  }

  for (const [symbol, recentRows] of recentRowsBySymbol.entries()) {
    const latest = recentRows[0];
    const previous = recentRows[1];
    if (!latest) continue;

    const close = Number(latest.close);
    const previousClose = previous ? Number(previous.close) : null;
    const changePct = previousClose && previousClose !== 0 ? ((close - previousClose) / previousClose) * 100 : null;

    stats.set(symbol, {
      close,
      open: Number(latest.open),
      volume: Number(latest.volume),
      changePct,
      time: latest.time,
    });
  }

  return stats;
}

// Persists the per-request stats computed above onto `instruments` so the
// stocks list can filter/sort/read prices directly off the instruments
// table (fast, works across the whole table) instead of recomputing a
// 2-row candles lookback per symbol on every read.
//
// Batched as UPDATE ... FROM (VALUES ...) - the same proven pattern
// sector-classification.service.ts's bulkUpdateClassification already
// uses - instead of one UPDATE per symbol. A full-market refresh
// (refreshAllLatestInstrumentPrices's 200-symbol chunks, up to ~9,900
// NSE instruments) previously issued up to ~9,900 sequential round trips
// for this step alone; this issues at most ceil(symbolCount / 500).
//
// latestChangePct is nullable (a symbol's first-ever synced day has no
// prior close to diff against) - explicitly cast to ::numeric in the
// VALUES list so Postgres can't fail to infer that column's type on a
// chunk where every row happens to be NULL (a real, if rare, case for a
// newly-hydrated batch of symbols). All other value casts are there for
// the same reason, applied uniformly rather than only where currently
// required, so this stays correct if a future chunk's row order changes.
export async function refreshLatestInstrumentStats(exchange: string, symbols: string[], dbClient: DbOrTx = db) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  if (uniqueSymbols.length === 0) return;

  const stats = await getLatestStockStats(uniqueSymbols, exchange, dbClient);
  await applyLatestInstrumentStats(exchange, stats, dbClient);
}

export type LatestInstrumentStat = {
  close: number;
  open: number;
  volume: number;
  changePct: number | null;
  time: string;
};

// The actual bulk write, split out from refreshLatestInstrumentStats above
// so it's directly testable (see
// market-data.instrument-stats-bulk-update.test.ts) against a fake
// dbClient without needing to also fake getLatestStockStats's own
// candles window-function query - this function's own contract is "given
// already-computed stats, apply them", independent of how they were
// computed.
export async function applyLatestInstrumentStats(
  exchange: string,
  stats: Map<string, LatestInstrumentStat>,
  dbClient: DbOrTx = db
) {
  const statRows = [...stats.entries()];
  if (statRows.length === 0) return;

  for (let index = 0; index < statRows.length; index += INSTRUMENT_STATS_UPDATE_CHUNK_SIZE) {
    const chunk = statRows.slice(index, index + INSTRUMENT_STATS_UPDATE_CHUNK_SIZE);

    const values = sql.join(
      chunk.map(
        ([symbol, stat]) =>
          sql`(${symbol}::text, ${stat.close}::numeric, ${stat.open}::numeric, ${stat.volume}::numeric, ${stat.changePct}::numeric, ${stat.time}::date)`
      ),
      sql`, `
    );

    await dbClient.execute(sql`
      UPDATE instruments AS i
      SET
        latest_close = v.close,
        latest_open = v.open,
        latest_volume = v.volume,
        latest_change_pct = v.change_pct,
        latest_price_at = v.price_at,
        updated_at = now()
      FROM (VALUES ${values}) AS v(symbol, close, open, volume, change_pct, price_at)
      WHERE i.exchange = ${exchange} AND i.symbol = v.symbol
    `);
  }
}
