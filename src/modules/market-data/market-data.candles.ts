import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candles } from "../../db/schema";
import { CANDLE_SOURCE, CANDLE_TIMEFRAME, type CandleTimeframe } from "../../shared/constants";
import { logger } from "../../shared/logger";
import type { ProviderDailyCandle } from "../data-provider/data-provider.types";
import { aggregateWeeklyCandles } from "./candle-aggregation";
import { getTodayDate } from "./market-data.dates";

const CANDLE_UPSERT_CHUNK_SIZE = 500;
const CANDLE_READ_SYMBOL_BATCH_SIZE = 60;
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
  instrumentId: string;
  timeframe: CandleTimeframe;
}) {
  const [row] = await db
    .select({
      from: sql<string | null>`min(${candles.time})`,
      to: sql<string | null>`max(${candles.time})`,
    })
    .from(candles)
    .where(and(eq(candles.instrumentId, input.instrumentId), eq(candles.timeframe, input.timeframe)));

  if (!row?.from || !row.to) return null;

  return {
    from: String(row.from),
    to: String(row.to),
  };
}

export type CandleCoverageInstrumentInput = { instrumentId: string; symbol: string };

// Bounded to time <= requiredFromDate rather than an unbounded min(time)
// GROUP BY over full history: a symbol's earliest candle is at/before
// requiredFromDate if and only if at least one row exists in that bounded
// range, so this is logically equivalent to the old "earliest >
// requiredFromDate" check while only touching hypertable chunks at/before
// the cutoff instead of every chunk up to the present. The unbounded scan
// across 200+ symbols was hitting both the 30s DB statement timeout and
// Postgres "out of shared memory" (53200 - too many chunk locks in one
// query) in production.
export async function findSymbolsNeedingHistoryBackfill(input: {
  instruments: CandleCoverageInstrumentInput[];
  requiredFromDate: string;
  timeframe?: CandleTimeframe;
}): Promise<string[]> {
  if (input.instruments.length === 0) return [];

  const timeframe = input.timeframe ?? CANDLE_TIMEFRAME.day;
  const coveredInstrumentIds = new Set<string>();

  for (let start = 0; start < input.instruments.length; start += CANDLE_COVERAGE_SYMBOL_BATCH_SIZE) {
    const batch = input.instruments.slice(start, start + CANDLE_COVERAGE_SYMBOL_BATCH_SIZE);
    const rows = await db
      .selectDistinct({ instrumentId: candles.instrumentId })
      .from(candles)
      .where(
        and(
          inArray(
            candles.instrumentId,
            batch.map((instrument) => instrument.instrumentId)
          ),
          eq(candles.timeframe, timeframe),
          lte(candles.time, input.requiredFromDate)
        )
      );

    for (const row of rows) coveredInstrumentIds.add(row.instrumentId);
  }

  return input.instruments
    .filter((instrument) => !coveredInstrumentIds.has(instrument.instrumentId))
    .map((instrument) => instrument.symbol);
}

export async function readChartCandles(input: {
  instrumentId: string;
  timeframe: CandleTimeframe;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
}) {
  const filters = [
    eq(candles.instrumentId, input.instrumentId),
    eq(candles.timeframe, input.timeframe),
    input.from ? gte(candles.time, input.from) : undefined,
    input.to ? lte(candles.time, input.to) : undefined,
    input.before ? lt(candles.time, input.before) : undefined,
  ].filter(Boolean);

  const query = db
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
    .orderBy(input.limit ? desc(candles.time) : asc(candles.time));

  const rows = input.limit ? await query.limit(input.limit) : await query;

  return input.limit ? rows.reverse() : rows;
}

export async function readCandleDatesInRange(input: {
  instrumentId: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
}): Promise<Set<string>> {
  const rows = await db
    .select({ time: candles.time })
    .from(candles)
    .where(
      and(
        eq(candles.instrumentId, input.instrumentId),
        eq(candles.timeframe, input.timeframe),
        gte(candles.time, input.from),
        lte(candles.time, input.to)
      )
    );

  return new Set(rows.map((row) => row.time));
}

export type ScannerDailyClose = { time: string; close: number };

export async function readScannerDailyCloses(input: {
  instrumentId: string;
  from?: string;
  to?: string;
}): Promise<ScannerDailyClose[]> {
  const filters = [
    eq(candles.instrumentId, input.instrumentId),
    eq(candles.timeframe, CANDLE_TIMEFRAME.day),
    input.from ? gte(candles.time, input.from) : undefined,
    input.to ? lte(candles.time, input.to) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({ time: candles.time, close: candles.close })
    .from(candles)
    .where(and(...filters))
    .orderBy(asc(candles.time));

  return rows.map((row) => ({ time: row.time, close: Number(row.close) }));
}

export type MetricCandleInstrumentInput = { instrumentId: string; symbol: string };

export type MetricDailyClose = ScannerDailyClose & { symbol: string };

export async function readMetricDailyCloses(input: {
  instruments: MetricCandleInstrumentInput[];
  from: string;
  to?: string;
}): Promise<MetricDailyClose[]> {
  if (input.instruments.length === 0) return [];

  const to = input.to ?? getTodayDate();
  const merged: MetricDailyClose[] = [];

  for (let start = 0; start < input.instruments.length; start += CANDLE_READ_SYMBOL_BATCH_SIZE) {
    const batch = input.instruments.slice(start, start + CANDLE_READ_SYMBOL_BATCH_SIZE);
    const rows = await db
      .select({ symbol: candles.symbol, time: candles.time, close: candles.close })
      .from(candles)
      .where(
        and(
          eq(candles.timeframe, CANDLE_TIMEFRAME.day),
          gte(candles.time, input.from),
          lte(candles.time, to),
          inArray(candles.instrumentId, batch.map((instrument) => instrument.instrumentId)),
        ),
      )
      .orderBy(asc(candles.symbol), asc(candles.time));

    merged.push(...rows.map((row) => ({ symbol: row.symbol, time: row.time, close: Number(row.close) })));
  }

  return merged;
}

export async function readMetricCandles(input: {
  instruments: MetricCandleInstrumentInput[];
  timeframe: CandleTimeframe;
  from: string;
  to?: string;
}): Promise<MetricCandle[]> {
  if (input.instruments.length === 0) return [];

  const to = input.to ?? getTodayDate();
  const merged: MetricCandle[] = [];

  for (let start = 0; start < input.instruments.length; start += CANDLE_READ_SYMBOL_BATCH_SIZE) {
    const batch = input.instruments.slice(start, start + CANDLE_READ_SYMBOL_BATCH_SIZE);
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
          eq(candles.timeframe, input.timeframe),
          gte(candles.time, input.from),
          lte(candles.time, to),
          inArray(
            candles.instrumentId,
            batch.map((instrument) => instrument.instrumentId)
          )
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
    instrumentId: string;
    from: string;
    to: string;
  },
  dbClient: DbOrTx = db
) {
  await dbClient
    .delete(candles)
    .where(
      and(
        eq(candles.instrumentId, input.instrumentId),
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
        target: [candles.instrumentId, candles.timeframe, candles.time],
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
    candlesByKey.set(`${input.instrumentId}:${input.timeframe}:${input.time}`, input);
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
        instrumentId: input.instrumentId,
        from: input.from,
        to: input.to,
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
