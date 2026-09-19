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

const INSTRUMENT_UPSERT_CHUNK_SIZE = 500;
const INSTRUMENT_STATS_UPDATE_CHUNK_SIZE = 500;
const POSTGRES_UNIQUE_VIOLATION = "23505";

export type InstrumentBySymbolRow = {
  id: string;
  symbol: string;
  instrumentToken: string;
  provider: string;
};

export async function getInstrumentsBySymbol(symbols: string[], exchange: string = DEFAULT_EXCHANGE) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  if (uniqueSymbols.length === 0) return new Map<string, InstrumentBySymbolRow>();

  const rows = await db
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      instrumentToken: instruments.instrumentToken,
      provider: instruments.provider,
    })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), inArray(instruments.symbol, uniqueSymbols)));

  return new Map(rows.map((row) => [row.symbol, row]));
}

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

  const resolved = new Map<string, InstrumentBySymbolRow>();
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

type InstrumentIdentityRow = { id: string; exchange: string; symbol: string };

type InstrumentRenameApplication = InstrumentUpsertInput & { instrumentId: string; fromSymbol: string };

type InstrumentRenameConflict = {
  provider: string;
  instrumentToken: string;
  exchange: string;
  instrumentId: string;
  fromSymbol: string;
  toSymbol: string;
  conflictingInstrumentId: string;
};

async function findInstrumentsByProviderToken(
  provider: string,
  tokens: string[],
  dbClient: DbOrTx
): Promise<Map<string, InstrumentIdentityRow>> {
  if (tokens.length === 0) return new Map();

  const rows = await dbClient
    .select({
      id: instruments.id,
      exchange: instruments.exchange,
      symbol: instruments.symbol,
      instrumentToken: instruments.instrumentToken,
    })
    .from(instruments)
    .where(and(eq(instruments.provider, provider), inArray(instruments.instrumentToken, tokens)));

  return new Map(rows.map((row) => [row.instrumentToken, row] as const));
}

async function findInstrumentsByExchangeSymbol(
  identities: InstrumentIdentity[],
  dbClient: DbOrTx
): Promise<Map<string, InstrumentIdentityRow>> {
  const symbolsByExchange = new Map<string, Set<string>>();
  for (const identity of identities) {
    const set = symbolsByExchange.get(identity.exchange) ?? new Set<string>();
    set.add(identity.symbol);
    symbolsByExchange.set(identity.exchange, set);
  }

  const resolved = new Map<string, InstrumentIdentityRow>();
  for (const [exchange, symbols] of symbolsByExchange) {
    const rows = await dbClient
      .select({ id: instruments.id, exchange: instruments.exchange, symbol: instruments.symbol })
      .from(instruments)
      .where(and(eq(instruments.exchange, exchange), inArray(instruments.symbol, [...symbols])));

    for (const row of rows) resolved.set(`${row.exchange}:${row.symbol}`, row);
  }

  return resolved;
}

async function partitionInstrumentUpserts(
  inputs: InstrumentUpsertInput[],
  provider: string,
  dbClient: DbOrTx
): Promise<{
  renames: InstrumentRenameApplication[];
  conflicts: InstrumentRenameConflict[];
  passthrough: InstrumentUpsertInput[];
}> {
  const byToken = await findInstrumentsByProviderToken(
    provider,
    inputs.map((row) => row.instrumentToken),
    dbClient
  );

  const passthrough: InstrumentUpsertInput[] = [];
  const renameCandidates: Array<{ input: InstrumentUpsertInput; symbol: string; existing: InstrumentIdentityRow }> = [];

  for (const row of inputs) {
    const symbol = normalizeSymbol(row.symbol);
    const existing = byToken.get(row.instrumentToken);

    if (!existing || existing.exchange !== row.exchange || existing.symbol === symbol) {
      passthrough.push(row);
      continue;
    }

    renameCandidates.push({ input: row, symbol, existing });
  }

  if (renameCandidates.length === 0) {
    return { renames: [], conflicts: [], passthrough };
  }

  const byNewIdentity = await findInstrumentsByExchangeSymbol(
    renameCandidates.map((candidate) => ({ exchange: candidate.input.exchange, symbol: candidate.symbol })),
    dbClient
  );

  const renames: InstrumentRenameApplication[] = [];
  const conflicts: InstrumentRenameConflict[] = [];

  for (const candidate of renameCandidates) {
    const conflictingOwner = byNewIdentity.get(`${candidate.input.exchange}:${candidate.symbol}`);

    if (conflictingOwner && conflictingOwner.id !== candidate.existing.id) {
      conflicts.push({
        provider,
        instrumentToken: candidate.input.instrumentToken,
        exchange: candidate.input.exchange,
        instrumentId: candidate.existing.id,
        fromSymbol: candidate.existing.symbol,
        toSymbol: candidate.symbol,
        conflictingInstrumentId: conflictingOwner.id,
      });
      continue;
    }

    renames.push({ ...candidate.input, instrumentId: candidate.existing.id, fromSymbol: candidate.existing.symbol });
  }

  return { renames, conflicts, passthrough };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === POSTGRES_UNIQUE_VIOLATION);
}

async function findConflictingInstrumentId(
  exchange: string,
  symbol: string,
  excludingInstrumentId: string,
  dbClient: DbOrTx
): Promise<string | null> {
  const [row] = await dbClient
    .select({ id: instruments.id })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.symbol, symbol)))
    .limit(1);

  if (!row || row.id === excludingInstrumentId) return null;
  return row.id;
}

async function applyInstrumentRenames(
  renames: InstrumentRenameApplication[],
  provider: string,
  dbClient: DbOrTx
): Promise<InstrumentRenameConflict[]> {
  const conflicts: InstrumentRenameConflict[] = [];

  for (const rename of renames) {
    const toSymbol = normalizeSymbol(rename.symbol);

    try {
      await dbClient
        .update(instruments)
        .set({
          provider,
          symbol: toSymbol,
          name: rename.name,
          instrumentToken: rename.instrumentToken,
          segment: rename.segment,
          active: true,
          updatedAt: new Date(),
        })
        .where(eq(instruments.id, rename.instrumentId));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const conflictingInstrumentId = await findConflictingInstrumentId(
        rename.exchange,
        toSymbol,
        rename.instrumentId,
        dbClient
      );
      conflicts.push({
        provider,
        instrumentToken: rename.instrumentToken,
        exchange: rename.exchange,
        instrumentId: rename.instrumentId,
        fromSymbol: rename.fromSymbol,
        toSymbol,
        conflictingInstrumentId: conflictingInstrumentId ?? "unknown",
      });
    }
  }

  return conflicts;
}

async function upsertInstrumentsByExchangeSymbol(
  inputs: InstrumentUpsertInput[],
  provider: string,
  dbClient: DbOrTx
) {
  for (let index = 0; index < inputs.length; index += INSTRUMENT_UPSERT_CHUNK_SIZE) {
    const chunk = inputs.slice(index, index + INSTRUMENT_UPSERT_CHUNK_SIZE);
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

export async function upsertInstruments(input: InstrumentUpsertInput[], provider: string, dbClient: DbOrTx = db) {
  const dedupedInput = dedupeInstrumentUpsertInputs(input);
  const { renames, conflicts, passthrough } = await partitionInstrumentUpserts(dedupedInput, provider, dbClient);

  const renameConflicts = await applyInstrumentRenames(renames, provider, dbClient);
  const allConflicts = [...conflicts, ...renameConflicts];

  if (allConflicts.length > 0) {
    logger.warn(
      { provider, conflicts: allConflicts },
      "Instrument rename skipped: target exchange+symbol already belongs to another instrument"
    );
  }

  await upsertInstrumentsByExchangeSymbol(passthrough, provider, dbClient);
}

// Latest two daily candles per symbol. Candles are looked up by instrument_id
// (candles_instrument_id_timeframe_time_unique -> newest-first index scan that
// stops after 2 rows), with the instrument found through its
// (exchange, symbol) unique key. Filtering candles by exchange + symbol has had
// no index since migration 0020 dropped candles_exchange_symbol_timeframe_time_unique,
// which made every lookup scan the whole hypertable.
export function buildLatestCandleStatsQuery(symbols: string[], exchange: string) {
  if (symbols.length === 1) {
    const [symbol] = symbols;
    return sql`
      SELECT ${symbol}::text AS symbol, c.open, c.close, c.volume, c.time::text AS time
      FROM candles c
      WHERE c.instrument_id = (
          SELECT i.id FROM instruments i WHERE i.exchange = ${exchange} AND i.symbol = ${symbol}
        )
        AND c.timeframe = ${CANDLE_TIMEFRAME.day}
      ORDER BY c.time DESC
      LIMIT 2
    `;
  }

  return sql`
    SELECT i.symbol AS symbol, ranked.open, ranked.close, ranked.volume, ranked.time::text AS time
    FROM instruments i
    CROSS JOIN LATERAL (
      SELECT c.open, c.close, c.volume, c.time
      FROM candles c
      WHERE c.instrument_id = i.id
        AND c.timeframe = ${CANDLE_TIMEFRAME.day}
      ORDER BY c.time DESC
      LIMIT 2
    ) ranked
    WHERE i.exchange = ${exchange}
      AND i.symbol = ANY(ARRAY[${sql.join(symbols.map((symbol) => sql`${symbol}`), sql`, `)}]::text[])
    ORDER BY i.symbol, ranked.time DESC
  `;
}

type LatestStockStatsRow = {
  symbol: string;
  open: string;
  close: string;
  volume: string;
  time: string;
};

async function getLatestStockStats(symbols: string[], exchange: string = DEFAULT_EXCHANGE, dbClient: DbOrTx = db) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  const stats = new Map<
    string,
    { close: number; open: number; volume: number; changePct: number | null; time: string }
  >();

  if (uniqueSymbols.length === 0) return stats;

  const startedAt = Date.now();
  const result = await dbClient.execute<LatestStockStatsRow>(buildLatestCandleStatsQuery(uniqueSymbols, exchange));
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
