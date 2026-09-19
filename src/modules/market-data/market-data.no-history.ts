import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candleBootstrapCheckpoints } from "../../db/schema";
import { CANDLE_BOOTSTRAP_STATUS, CANDLE_TIMEFRAME } from "../../shared/constants";
import { upsertCandleBootstrapCheckpoint } from "./market-data.candle-bootstrap-checkpoints";

// "GlobalDataFeeds answered a full-range GetHistory for this instrument with a
// successful, empty response." Persisted in candle_bootstrap_checkpoints (one row
// per exchange + symbol) so it survives restarts, and so "never checked" (no row)
// stays distinguishable from "checked, provider has no history" (success row with
// candle_count 0). Provider errors, timeouts and persistence failures never write
// this row - they stay plain retryable failures.
export const NO_HISTORY_CHECKPOINT_KIND = "no-history-check";
const NO_HISTORY_CHECKPOINT_VERSION = 1;

// Recheck policy: a confirmed no-history instrument is left alone for 7 days, then
// becomes eligible for one more full-range check (an index can gain history later).
// An admin per-symbol refresh rechecks immediately. The row is deleted as soon as
// candles are actually stored, so it can never mask real data.
export const NO_HISTORY_RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function noHistoryRecheckCutoff(now: Date = new Date()) {
  return new Date(now.getTime() - NO_HISTORY_RECHECK_INTERVAL_MS);
}

export function isNoHistoryRecheckDue(confirmedAt: Date | null, now: Date = new Date()) {
  return confirmedAt === null || confirmedAt.getTime() <= noHistoryRecheckCutoff(now).getTime();
}

export async function readNoHistoryConfirmedAt(
  exchange: string,
  symbol: string,
  dbClient: DbOrTx = db
): Promise<Date | null> {
  const [row] = await dbClient
    .select({ completedAt: candleBootstrapCheckpoints.completedAt })
    .from(candleBootstrapCheckpoints)
    .where(
      and(
        eq(candleBootstrapCheckpoints.exchange, exchange),
        eq(candleBootstrapCheckpoints.symbol, symbol),
        eq(candleBootstrapCheckpoints.timeframe, CANDLE_TIMEFRAME.day),
        eq(candleBootstrapCheckpoints.kind, NO_HISTORY_CHECKPOINT_KIND),
        eq(candleBootstrapCheckpoints.status, CANDLE_BOOTSTRAP_STATUS.success)
      )
    )
    .limit(1);

  return row?.completedAt ?? null;
}

export async function recordNoHistoryConfirmed(
  input: { exchange: string; symbol: string; requestedFrom: string; requestedTo: string },
  dbClient: DbOrTx = db
) {
  await upsertCandleBootstrapCheckpoint(
    {
      exchange: input.exchange,
      symbol: input.symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      kind: NO_HISTORY_CHECKPOINT_KIND,
      bootstrapVersion: NO_HISTORY_CHECKPOINT_VERSION,
      status: CANDLE_BOOTSTRAP_STATUS.success,
      requestedFrom: input.requestedFrom,
      requestedTo: input.requestedTo,
      candleCount: 0,
    },
    dbClient
  );
}

export async function clearNoHistory(exchange: string, symbol: string, dbClient: DbOrTx = db) {
  await dbClient
    .delete(candleBootstrapCheckpoints)
    .where(
      and(
        eq(candleBootstrapCheckpoints.exchange, exchange),
        eq(candleBootstrapCheckpoints.symbol, symbol),
        eq(candleBootstrapCheckpoints.timeframe, CANDLE_TIMEFRAME.day),
        eq(candleBootstrapCheckpoints.kind, NO_HISTORY_CHECKPOINT_KIND)
      )
    );
}

// Every symbol on the exchange currently holding a confirmed no-history state.
export async function listNoHistorySymbols(exchange: string, dbClient: DbOrTx = db): Promise<Set<string>> {
  const rows = await dbClient
    .select({ symbol: candleBootstrapCheckpoints.symbol })
    .from(candleBootstrapCheckpoints)
    .where(
      and(
        eq(candleBootstrapCheckpoints.exchange, exchange),
        eq(candleBootstrapCheckpoints.timeframe, CANDLE_TIMEFRAME.day),
        eq(candleBootstrapCheckpoints.kind, NO_HISTORY_CHECKPOINT_KIND),
        eq(candleBootstrapCheckpoints.status, CANDLE_BOOTSTRAP_STATUS.success)
      )
    );

  return new Set(rows.map((row) => row.symbol));
}
