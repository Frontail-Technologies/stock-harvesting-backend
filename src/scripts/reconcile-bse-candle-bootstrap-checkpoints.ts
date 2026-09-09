import { and, between, eq, inArray } from "drizzle-orm";

import { db } from "../db/client";
import { candles, instruments } from "../db/schema";
import { CANDLE_BOOTSTRAP_STATUS, CANDLE_TIMEFRAME } from "../shared/constants";
import { getErrorMessage } from "../shared/errors";
import {
  BOOTSTRAP_KIND,
  BOOTSTRAP_VERSION,
  EXCHANGE,
  isBseEquitySegment,
} from "./bootstrap-bse-candles";
import { upsertCandleBootstrapCheckpoint } from "../modules/market-data/market-data.candle-bootstrap-checkpoints";
import { getDefaultChartHistoryFromDate, getTodayDate } from "../modules/market-data/market-data.dates";

// One-time reconciliation for production databases that already have
// candles from bootstrap runs that predate the checkpoint table (see
// bootstrap-bse-candles.ts / market-data.candle-bootstrap-checkpoints.ts).
// Without this, every one of those already-populated symbols would look
// "not bootstrapped" on the next run and get needlessly refetched.
//
// What this can and cannot prove from DB data alone:
// - It CANNOT reconstruct whether a given historical fetch was literally
//   the provider's full available history - that was never recorded before
//   checkpoints existed.
// - It CAN safely detect symbols that only ever received a *deep* historical
//   fetch: nothing else in this codebase ever writes a candle dated this far
//   in the past (syncLatestDailyCandlesForSymbols/refreshAllLatestInstrumentPrices
//   only ever touch the last 14 days). So a candle inside the first
//   RECONCILE_EARLY_WINDOW_DAYS of the requested range is proof-positive that
//   a real historical bootstrap ran and its provider response was persisted
//   (replaceCandlesAtomically is one transaction - the write is all-or-nothing).
//
// This is deliberately conservative: a genuinely-complete, recently-listed
// instrument (all its history starts after the early window) will NOT be
// reconciled here and is left for the next real bootstrap run to reprocess.
// That is safe and idempotent - it costs one redundant refetch, never a
// false "complete" marking. See the task's report for the exact numbers.
export const RECONCILE_EARLY_WINDOW_DAYS = 730;
const RECONCILE_BATCH_SIZE = 500;

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function findSymbolsWithDeepHistory(input: {
  exchange: string;
  symbols: string[];
  windowStart: string;
  windowEnd: string;
}): Promise<Set<string>> {
  const found = new Set<string>();
  if (input.symbols.length === 0) return found;

  for (let start = 0; start < input.symbols.length; start += RECONCILE_BATCH_SIZE) {
    const batch = input.symbols.slice(start, start + RECONCILE_BATCH_SIZE);
    const rows = await db
      .selectDistinct({ symbol: candles.symbol })
      .from(candles)
      .where(
        and(
          eq(candles.exchange, input.exchange),
          inArray(candles.symbol, batch),
          eq(candles.timeframe, CANDLE_TIMEFRAME.day),
          between(candles.time, input.windowStart, input.windowEnd)
        )
      );
    for (const row of rows) found.add(row.symbol);
  }

  return found;
}

async function main() {
  const requestedFrom = getDefaultChartHistoryFromDate();
  const windowEnd = addDays(requestedFrom, RECONCILE_EARLY_WINDOW_DAYS);
  const requestedTo = getTodayDate();

  console.log(`Reconciling ${EXCHANGE} candle bootstrap checkpoints.`);
  console.log(`Deep-history evidence window: ${requestedFrom} to ${windowEnd}`);

  const activeInstruments = await db
    .select({ symbol: instruments.symbol, segment: instruments.segment })
    .from(instruments)
    .where(and(eq(instruments.exchange, EXCHANGE), eq(instruments.active, true)));
  const selected = activeInstruments.filter((row) => isBseEquitySegment(row.segment));
  console.log(`BSE equity instruments considered: ${selected.length}`);

  let deepHistorySymbols: Set<string>;
  try {
    deepHistorySymbols = await findSymbolsWithDeepHistory({
      exchange: EXCHANGE,
      symbols: selected.map((row) => row.symbol),
      windowStart: requestedFrom,
      windowEnd,
    });
  } catch (error) {
    console.error("\nReconciliation lookup failed - aborting without writing any checkpoints.");
    console.error(`Reason: ${getErrorMessage(error, "Unknown error")}`);
    process.exit(1);
    return;
  }

  console.log(`Symbols with deep-history evidence (will be checkpointed as success): ${deepHistorySymbols.size}`);
  console.log(`Symbols left uncertain (will be retried by the next bootstrap run): ${selected.length - deepHistorySymbols.size}`);

  let written = 0;
  for (const symbol of deepHistorySymbols) {
    await upsertCandleBootstrapCheckpoint({
      exchange: EXCHANGE,
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      kind: BOOTSTRAP_KIND,
      bootstrapVersion: BOOTSTRAP_VERSION,
      status: CANDLE_BOOTSTRAP_STATUS.success,
      requestedFrom,
      requestedTo,
    });
    written++;
  }

  console.log(`\nWrote ${written} reconciled checkpoints.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
