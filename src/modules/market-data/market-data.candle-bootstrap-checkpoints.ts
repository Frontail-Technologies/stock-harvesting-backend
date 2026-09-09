import { and, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candleBootstrapCheckpoints } from "../../db/schema";
import { CANDLE_BOOTSTRAP_STATUS, type CandleBootstrapStatus, type CandleTimeframe } from "../../shared/constants";

// Persistence for the per-symbol historical-bootstrap resume checkpoint (see
// bootstrap-bse-candles.ts). Deliberately separate from market-data.candles.ts -
// this table is never read to decide what data to *serve*, only to decide
// whether a bulk bootstrap run needs to reprocess a symbol.

// Comfortably under Postgres's 65,535-param protocol limit, matching the
// same batching convention used elsewhere in this codebase (e.g.
// COLLECTION_MEMBER_WRITE_CHUNK_SIZE). The checkpoints table is small
// (one row per symbol per bootstrap kind) so this is about bounding query
// shape, not working around real data volume.
const CHECKPOINT_READ_BATCH_SIZE = 500;

export type CandleBootstrapCheckpoint = {
  symbol: string;
  status: CandleBootstrapStatus;
  bootstrapVersion: number;
  requestedFrom: string;
};

// Reads checkpoints for a (possibly large) symbol list in bounded batches
// against the small checkpoints table, unioning results into one map keyed
// by symbol. Any batch's rejection propagates immediately and is NOT
// swallowed - callers must fail closed rather than treat a lookup failure
// as "no symbol has a checkpoint" (which would look identical to "every
// symbol needs backfill", the exact bug this replaces).
export async function readCandleBootstrapCheckpointsInBatches(input: {
  exchange: string;
  symbols: string[];
  timeframe: CandleTimeframe;
  kind: string;
}): Promise<Map<string, CandleBootstrapCheckpoint>> {
  const checkpointsBySymbol = new Map<string, CandleBootstrapCheckpoint>();
  if (input.symbols.length === 0) return checkpointsBySymbol;

  for (let start = 0; start < input.symbols.length; start += CHECKPOINT_READ_BATCH_SIZE) {
    const batch = input.symbols.slice(start, start + CHECKPOINT_READ_BATCH_SIZE);
    const rows = await db
      .select({
        symbol: candleBootstrapCheckpoints.symbol,
        status: candleBootstrapCheckpoints.status,
        bootstrapVersion: candleBootstrapCheckpoints.bootstrapVersion,
        requestedFrom: candleBootstrapCheckpoints.requestedFrom,
      })
      .from(candleBootstrapCheckpoints)
      .where(
        and(
          eq(candleBootstrapCheckpoints.exchange, input.exchange),
          inArray(candleBootstrapCheckpoints.symbol, batch),
          eq(candleBootstrapCheckpoints.timeframe, input.timeframe),
          eq(candleBootstrapCheckpoints.kind, input.kind)
        )
      );

    for (const row of rows) {
      checkpointsBySymbol.set(row.symbol, row);
    }
  }

  return checkpointsBySymbol;
}

// A checkpoint only ever suppresses re-processing when it recorded a fully
// successful run (never "partial"/"failed"), was written under the exact
// bootstrap semantics being requested now (bootstrapVersion), and reached
// back at least as far as what's being requested now (requestedFrom) - a
// checkpoint from a shallower/older request must not suppress a deeper one.
export function isCandleBootstrapCheckpointSatisfied(
  checkpoint: CandleBootstrapCheckpoint | undefined,
  requirement: { bootstrapVersion: number; requestedFrom: string }
): boolean {
  if (!checkpoint) return false;
  if (checkpoint.status !== CANDLE_BOOTSTRAP_STATUS.success) return false;
  if (checkpoint.bootstrapVersion !== requirement.bootstrapVersion) return false;
  if (checkpoint.requestedFrom > requirement.requestedFrom) return false;
  return true;
}

export async function upsertCandleBootstrapCheckpoint(
  input: {
    exchange: string;
    symbol: string;
    timeframe: CandleTimeframe;
    kind: string;
    bootstrapVersion: number;
    status: CandleBootstrapStatus;
    requestedFrom: string;
    requestedTo?: string;
    candleCount?: number;
    lastError?: string;
  },
  dbClient: DbOrTx = db
) {
  const now = new Date();
  await dbClient
    .insert(candleBootstrapCheckpoints)
    .values({
      exchange: input.exchange,
      symbol: input.symbol,
      timeframe: input.timeframe,
      kind: input.kind,
      bootstrapVersion: input.bootstrapVersion,
      status: input.status,
      requestedFrom: input.requestedFrom,
      requestedTo: input.requestedTo,
      completedAt: now,
      candleCount: input.candleCount,
      lastError: input.lastError,
    })
    .onConflictDoUpdate({
      target: [
        candleBootstrapCheckpoints.exchange,
        candleBootstrapCheckpoints.symbol,
        candleBootstrapCheckpoints.timeframe,
        candleBootstrapCheckpoints.kind,
      ],
      set: {
        bootstrapVersion: input.bootstrapVersion,
        status: input.status,
        requestedFrom: input.requestedFrom,
        requestedTo: input.requestedTo ?? null,
        completedAt: now,
        candleCount: input.candleCount ?? null,
        lastError: input.lastError ?? null,
        updatedAt: now,
      },
    });
}
