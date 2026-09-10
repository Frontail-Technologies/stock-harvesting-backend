import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candles } from "../../db/schema";
import { CANDLE_SOURCE, CANDLE_TIMEFRAME, type CandleTimeframe } from "../../shared/constants";
import { logger } from "../../shared/logger";
import type { ProviderDailyCandle } from "../data-provider/data-provider.types";
import { aggregateWeeklyCandles } from "./candle-aggregation";
import { getTodayDate } from "./market-data.dates";

// Pure candle-table DB access (reads, upserts, atomic replacement) plus tightly coupled in-memory row transforms; deliberately does NOT own provider fetching, freshness decisions, or backfill/refresh orchestration - those stay in market-data.service.ts, which calls into this module.

const CANDLE_UPSERT_CHUNK_SIZE = 500;

// Multi-symbol candle reads are split into sequential batches of this many
// symbols. `candles` is a TimescaleDB hypertable on a 7-day chunk interval,
// so a single `symbol IN (...)` scan over a multi-year range fans out across
// hundreds/thousands of per-chunk index scans; at ~250 symbols this was
// hitting the 30s DB statement timeout in production (collection
// preparation for BSE 250 MICROCAP). Kept deliberately small - well under
// the ~250 that was observed failing - and run one after another so this
// never raises DB concurrency. Batches only change how the rows are
// fetched, never which rows: callers still get the exact same set, sorted
// the same way.
const CANDLE_READ_SYMBOL_BATCH_SIZE = 60;
// Coverage detection (findSymbolsNeedingHistoryBackfill) uses an even
// smaller batch: its query is an unbounded `min(time)` GROUP BY with no
// time filter at all, so every batch scans the full history of its symbols
// across every chunk - the most chunk-fan-out-heavy shape in this module.
const CANDLE_COVERAGE_SYMBOL_BATCH_SIZE = 40;

export type MetricCandle = {
  symbol: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandleUpsertInput = {
  instrumentId: string;
  exchange: string;
  symbol: string;
  timeframe: CandleTimeframe;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
};

export async function readCandleHistoryRange(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  exchange: string;
}) {
  const [row] = await db
    .select({
      from: sql<string | null>`min(${candles.time})`,
      to: sql<string | null>`max(${candles.time})`,
    })
    .from(candles)
    .where(
      and(
        eq(candles.exchange, input.exchange),
        eq(candles.symbol, input.symbol),
        eq(candles.timeframe, input.timeframe)
      )
    );

  if (!row?.from || !row.to) return null;

  return {
    from: String(row.from),
    to: String(row.to),
  };
}

// Bulk equivalent of readCandleHistoryRange's "earliest stored candle" check for many symbols at once (collection preparation's coverage scan); only decides whether a backfill *attempt* is worth making, never the final availability verdict (see hasSufficientWeeklyStrongHistory for that).
// The symbol list is scanned in small sequential batches: the query below is
// an unbounded `min(time)` GROUP BY (no time filter - that's semantically
// required, see the JS `earliest > requiredFromDate` check), so each symbol
// forces a scan across every hypertable chunk it has data in. Batching keeps
// any single query well under the DB timeout. Fails closed - if any batch
// throws, the whole call throws; a lookup failure must never be silently
// read as "no symbol has history" (which would look identical to "every
// symbol needs backfill").
export async function findSymbolsNeedingHistoryBackfill(input: {
  exchange: string;
  symbols: string[];
  requiredFromDate: string;
  timeframe?: CandleTimeframe;
}): Promise<string[]> {
  if (input.symbols.length === 0) return [];

  const timeframe = input.timeframe ?? CANDLE_TIMEFRAME.day;
  const earliestBySymbol = new Map<string, string>();

  for (let start = 0; start < input.symbols.length; start += CANDLE_COVERAGE_SYMBOL_BATCH_SIZE) {
    const batch = input.symbols.slice(start, start + CANDLE_COVERAGE_SYMBOL_BATCH_SIZE);
    const rows = await db
      .select({
        symbol: candles.symbol,
        earliest: sql<string>`min(${candles.time})`,
      })
      .from(candles)
      .where(
        and(
          eq(candles.exchange, input.exchange),
          inArray(candles.symbol, batch),
          eq(candles.timeframe, timeframe)
        )
      )
      .groupBy(candles.symbol);

    for (const row of rows) earliestBySymbol.set(row.symbol, row.earliest);
  }

  return input.symbols.filter((symbol) => {
    const earliest = earliestBySymbol.get(symbol);
    return !earliest || earliest > input.requiredFromDate;
  });
}

export async function readChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from?: string;
  to?: string;
  exchange: string;
}) {
  const filters = [
    eq(candles.exchange, input.exchange),
    eq(candles.symbol, input.symbol),
    eq(candles.timeframe, input.timeframe),
    input.from ? gte(candles.time, input.from) : undefined,
    input.to ? lte(candles.time, input.to) : undefined,
  ].filter(Boolean);

  // Narrowed projection, not `.select()` — every consumer only reads these 7 columns; the rest (id, exchange, symbol, timeframe, source, createdAt, updatedAt) are dead weight on a several-thousand-row chart history result.
  const rows = await db
    .select({
      instrumentId: candles.instrumentId,
      time: candles.time,
      open: candles.open,
      high: candles.high,
      low: candles.low,
      close: candles.close,
      volume: candles.volume,
    })
    .from(candles)
    .where(and(...filters))
    .orderBy(asc(candles.time));

  return rows;
}

// Reads OHLCV rows for many symbols over [from, to], sorted (symbol, time)
// ascending. `to` defaults to today: a candle can never be dated in the
// future, so this is an exact no-op on the row set, but it gives the query
// a bounded upper end instead of an open-ended `time >= from` that the
// planner has to treat as "to infinity". The symbol list is scanned in
// small sequential batches (see CANDLE_READ_SYMBOL_BATCH_SIZE) and the
// merged result is re-sorted to be byte-identical to the single-query
// version - only the fetch strategy changes, never the output.
export async function readMetricCandles(input: {
  exchange: string;
  symbols: string[];
  timeframe: CandleTimeframe;
  from: string;
  to?: string;
}): Promise<MetricCandle[]> {
  if (input.symbols.length === 0) return [];

  const to = input.to ?? getTodayDate();
  const merged: MetricCandle[] = [];

  for (let start = 0; start < input.symbols.length; start += CANDLE_READ_SYMBOL_BATCH_SIZE) {
    const batch = input.symbols.slice(start, start + CANDLE_READ_SYMBOL_BATCH_SIZE);
    const rows = await db
      .select({
        symbol: candles.symbol,
        time: candles.time,
        open: candles.open,
        high: candles.high,
        low: candles.low,
        close: candles.close,
        volume: candles.volume,
      })
      .from(candles)
      .where(
        and(
          eq(candles.exchange, input.exchange),
          eq(candles.timeframe, input.timeframe),
          gte(candles.time, input.from),
          lte(candles.time, to),
          inArray(candles.symbol, batch)
        )
      )
      .orderBy(asc(candles.symbol), asc(candles.time));

    for (const row of rows) {
      merged.push({
        symbol: row.symbol,
        time: row.time,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      });
    }
  }

  // Batches carry disjoint symbol subsets in the caller's original order, so
  // concatenation alone would not reproduce the single query's global
  // (symbol, time) ordering. Restore it explicitly.
  merged.sort((a, b) =>
    a.symbol === b.symbol
      ? a.time < b.time
        ? -1
        : a.time > b.time
          ? 1
          : 0
      : a.symbol < b.symbol
        ? -1
        : 1
  );

  return merged;
}

export function filterMetricCandlesFrom(rows: MetricCandle[], from: string) {
  return rows.filter((row) => row.time >= from);
}

export function groupMetricCandlesBySymbol(rows: MetricCandle[]) {
  const candlesBySymbol = new Map<string, MetricCandle[]>();

  for (const row of rows) {
    const currentRows = candlesBySymbol.get(row.symbol) ?? [];
    currentRows.push(row);
    candlesBySymbol.set(row.symbol, currentRows);
  }

  return candlesBySymbol;
}

export function deriveWeeklyMetricCandlesFromDaily(rows: MetricCandle[], weeklyFrom: string) {
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(rows);
  const weeklyCandles: MetricCandle[] = [];

  for (const [symbol, symbolRows] of dailyCandlesBySymbol.entries()) {
    const aggregatedRows = aggregateWeeklyCandles(
      symbolRows.map((row) => ({
        time: row.time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }))
    );

    for (const row of aggregatedRows) {
      if (row.time < weeklyFrom) continue;
      weeklyCandles.push({ symbol, ...row });
    }
  }

  return weeklyCandles.sort((a, b) =>
    a.symbol === b.symbol ? a.time.localeCompare(b.time) : a.symbol.localeCompare(b.symbol)
  );
}

export async function deleteCandlesForRefresh(
  input: {
    symbol: string;
    from: string;
    to: string;
    exchange: string;
  },
  dbClient: DbOrTx = db
) {
  await dbClient
    .delete(candles)
    .where(
      and(
        eq(candles.exchange, input.exchange),
        eq(candles.symbol, input.symbol),
        inArray(candles.timeframe, [CANDLE_TIMEFRAME.day, CANDLE_TIMEFRAME.week, CANDLE_TIMEFRAME.month]),
        gte(candles.time, input.from),
        lte(candles.time, input.to)
      )
    );
}

export async function upsertCandles(inputs: CandleUpsertInput[], dbClient: DbOrTx = db) {
  const dedupedInputs = dedupeCandleUpsertInputs(inputs);
  if (dedupedInputs.length === 0) return;

  const startedAt = Date.now();
  let insertedCount = 0;
  let updatedCount = 0;

  for (let index = 0; index < dedupedInputs.length; index += CANDLE_UPSERT_CHUNK_SIZE) {
    const chunk = dedupedInputs.slice(index, index + CANDLE_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    // `xmax = 0` is the standard Postgres idiom for distinguishing an INSERT from an UPDATE inside one ON CONFLICT statement; used only to report accurate insert/update counts below, never part of application logic.
    const results = await dbClient
      .insert(candles)
      .values(
        chunk.map((input) => ({
          instrumentId: input.instrumentId,
          exchange: input.exchange,
          symbol: input.symbol,
          timeframe: input.timeframe,
          time: input.time,
          open: String(input.open),
          high: String(input.high),
          low: String(input.low),
          close: String(input.close),
          volume: String(input.volume),
          source: input.source,
        }))
      )
      .onConflictDoUpdate({
        target: [candles.exchange, candles.symbol, candles.timeframe, candles.time],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          source: sql`excluded.source`,
          updatedAt: new Date(),
        },
      })
      .returning({ wasInsert: sql<boolean>`(xmax = 0)` });

    for (const row of results) {
      if (row.wasInsert) insertedCount++;
      else updatedCount++;
    }
  }

  logger.debug(
    {
      inputCount: inputs.length,
      dedupedCount: dedupedInputs.length,
      insertedCount,
      updatedCount,
      durationMs: Date.now() - startedAt,
    },
    "upsertCandles complete"
  );
}

function dedupeCandleUpsertInputs(inputs: CandleUpsertInput[]) {
  const candlesByKey = new Map<string, CandleUpsertInput>();

  for (const input of inputs) {
    candlesByKey.set(`${input.exchange}:${input.symbol}:${input.timeframe}:${input.time}`, input);
  }

  const deduped = Array.from(candlesByKey.values());
  const droppedCount = inputs.length - deduped.length;
  if (droppedCount > 0) {
    logger.warn(
      { inputCount: inputs.length, dedupedCount: deduped.length, droppedCount },
      "Dropped duplicate candle rows within a single upsert batch"
    );
  }

  return deduped;
}

// Deletes the requested exchange/symbol/date-range across all 3 timeframes then upserts fresh rows, all inside one transaction so any failure rolls back the delete too. Takes an explicit dbClient (not module-level db) so it can be tested against a fake DbOrTx without faking the provider-fetch layer backfillDailyCandles wraps around it.
export async function replaceCandlesAtomically(
  dbClient: DbOrTx,
  input: {
    instrumentId: string;
    exchange: string;
    symbol: string;
    from: string;
    to: string;
    daily: ProviderDailyCandle[];
    weekly: ProviderDailyCandle[];
    monthly: ProviderDailyCandle[];
  }
) {
  await dbClient.transaction(async (tx) => {
    await deleteCandlesForRefresh(
      {
        symbol: input.symbol,
        from: input.from,
        to: input.to,
        exchange: input.exchange,
      },
      tx
    );

    await upsertCandles(
      input.daily.map((candle) => ({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        symbol: input.symbol,
        timeframe: CANDLE_TIMEFRAME.day,
        source: CANDLE_SOURCE.provider,
        ...candle,
      })),
      tx
    );
    await upsertCandles(
      input.weekly.map((candle) => ({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        symbol: input.symbol,
        timeframe: CANDLE_TIMEFRAME.week,
        source: CANDLE_SOURCE.derived,
        ...candle,
      })),
      tx
    );
    await upsertCandles(
      input.monthly.map((candle) => ({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        symbol: input.symbol,
        timeframe: CANDLE_TIMEFRAME.month,
        source: CANDLE_SOURCE.derived,
        ...candle,
      })),
      tx
    );
  });
}
