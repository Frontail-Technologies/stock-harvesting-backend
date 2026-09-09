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

// Instrument-table DB operations that don't need provider-search/backfill orchestration; getOrCreateInstrument lives in market-data.instrument-sync.ts instead, since it falls back to provider-orchestration on a miss.

const INSTRUMENT_UPSERT_CHUNK_SIZE = 500;
// 6 params/row x 500 = 3,000 params/statement - comfortably under Postgres's 65,535-parameter protocol limit.
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

// Existence-only check ("does this exchange have any usable data at all"),
// deliberately not routed through buildStockFilters/countStockRows - those
// apply search-listing shaping (price>0 unless includeUnpriced, move
// filters, etc.) that would under-report availability for a freshly-synced
// instrument that hasn't been priced yet. `provider` narrows this to the
// exact provider a caller's own filter would require (e.g. NSE only ever
// matches `provider = zerodha` rows, same as buildStockFilters) - passing
// it keeps this check accurate to what a real search on that exchange
// would actually find, not just "any row exists at all".
export async function hasActiveInstruments(
  exchange: string,
  provider?: string,
  dbClient: DbOrTx = db
): Promise<boolean> {
  const [row] = await dbClient
    .select({ id: instruments.id })
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, exchange),
        eq(instruments.active, true),
        provider ? eq(instruments.provider, provider) : undefined
      )
    )
    .limit(1);

  return Boolean(row);
}

export type InstrumentIdentity = { exchange: string; symbol: string };

export async function resolveInstrumentsForSymbols(identities: InstrumentIdentity[]) {
  const symbolsByExchange = new Map<string, Set<string>>();

  for (const identity of identities) {
    const exchange = identity.exchange?.trim();
    const symbol = normalizeSymbol(identity.symbol ?? "");
    if (!exchange || !symbol) continue;
    const set = symbolsByExchange.get(exchange) ?? new Set<string>();
    set.add(symbol);
    symbolsByExchange.set(exchange, set);
  }

  const resolved = new Map<string, typeof instruments.$inferSelect>();
  if (symbolsByExchange.size === 0) return resolved;

  const rowsByExchange = await Promise.all(
    [...symbolsByExchange.entries()].map(async ([exchange, symbolSet]) => ({
      exchange,
      rows: await getInstrumentsBySymbol([...symbolSet], exchange),
    }))
  );

  for (const { exchange, rows } of rowsByExchange) {
    for (const [symbol, row] of rows) {
      resolved.set(`${exchange}:${symbol}`, row);
    }
  }

  return resolved;
}

export async function createFallbackInstrument(symbol: string, exchange: string = DEFAULT_EXCHANGE) {
  const normalizedSymbol = normalizeSymbol(symbol);
  // The provider tag (token format) can use the static registry even when that provider is disabled; the token itself always comes from an eligible adapter.
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

// `instruments` enforces two unique constraints (exchange+symbol, provider+instrument_token), but onConflictDoUpdate can only target one, so a batch colliding on *either* key fails the whole INSERT. Both dedup passes run first, last-write-wins, symbol-level then token-level, so a vendor anomaly only drops a row, not the whole batch.
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

// dedupeInstrumentUpsertInputs only catches collisions within this batch. A row can still collide with a different (exchange, symbol) already in the DB (e.g. a provider reusing a token across segments), uncovered by the ON CONFLICT target - drop those here rather than aborting the whole sync.
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

// Uses a row_number() window function (filtered in an outer query since row_number() can't be filtered directly in WHERE) to fetch exactly the latest 2 rows per symbol, instead of an unbounded ORDER BY returning each symbol's entire history.
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

// Persists computed stats onto `instruments` so the stocks list can read/sort/filter prices directly instead of recomputing a candles lookback per symbol; batched as UPDATE ... FROM (VALUES ...) rather than one UPDATE per symbol.
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

// Split out from refreshLatestInstrumentStats so the bulk write is directly testable against a fake dbClient (see market-data.instrument-stats-bulk-update.test.ts) independent of getLatestStockStats's own query.
export async function applyLatestInstrumentStats(
  exchange: string,
  stats: Map<string, LatestInstrumentStat>,
  dbClient: DbOrTx = db
) {
  const statRows = [...stats.entries()];
  if (statRows.length === 0) return;

  for (let index = 0; index < statRows.length; index += INSTRUMENT_STATS_UPDATE_CHUNK_SIZE) {
    const chunk = statRows.slice(index, index + INSTRUMENT_STATS_UPDATE_CHUNK_SIZE);

    // Explicit ::numeric casts so Postgres can't fail to infer changePct's type on a chunk where it happens to be NULL for every row.
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
