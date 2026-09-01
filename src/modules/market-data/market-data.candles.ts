import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candles } from "../../db/schema";
import { CANDLE_SOURCE, CANDLE_TIMEFRAME, type CandleTimeframe } from "../../shared/constants";
import { logger } from "../../shared/logger";
import type { ProviderDailyCandle } from "../data-provider/data-provider.types";
import { aggregateWeeklyCandles } from "./candle-aggregation";

// Pure candle-table DB access (reads, upserts, atomic replacement) plus the
// handful of in-memory row transforms tightly coupled to those reads.
// Deliberately does NOT own: provider fetching, freshness decisions, or
// backfill/refresh orchestration - those stay in market-data.service.ts,
// which calls into this module rather than the other way around.

const CANDLE_UPSERT_CHUNK_SIZE = 500;

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

  // Narrowed projection, not `.select()` — every consumer of this function
  // (getChartCandles' response mapping, deriveStoredCandlesForTimeframe's
  // weekly/monthly aggregation) only ever reads these 7 columns; the rest
  // (id, exchange, symbol, timeframe, source, createdAt, updatedAt) are
  // dead weight on what can be a several-thousand-row result for a chart's
  // full history.
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

export async function readMetricCandles(input: {
  exchange: string;
  symbols: string[];
  timeframe: CandleTimeframe;
  from: string;
}) {
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
        inArray(candles.symbol, input.symbols)
      )
    )
    .orderBy(asc(candles.symbol), asc(candles.time));

  return rows.map((row) => ({
    symbol: row.symbol,
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
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

    // `xmax = 0` is a well-known Postgres idiom for distinguishing an
    // INSERT from an UPDATE inside a single ON CONFLICT statement: a freshly
    // inserted row has no prior transaction ID recorded in xmax, an updated
    // row does. Used only to report accurate insert/update counts below -
    // never part of application logic.
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

// Deletes the requested exchange/symbol/date-range across all 3 timeframes,
// then upserts the fresh daily/weekly/monthly rows - all inside one
// transaction, so a failure at any step (including a duplicate-key error
// surfaced from upsertCandles) rolls back the delete too, instead of
// leaving the range empty. Takes an explicit dbClient (not the module-level
// db) so it can be exercised directly against a fake DbOrTx in tests,
// without needing to also fake the provider-fetch layer that
// backfillDailyCandles wraps around it.
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
