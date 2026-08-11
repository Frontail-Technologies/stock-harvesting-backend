import { sql } from "drizzle-orm";

import { db } from "../db/client";

// Verifies candles.instrument_id is populated on every existing row before
// making it NOT NULL. The application already always supplies it (see
// CandleUpsertInput in market-data.service.ts — the field isn't optional
// there), but the column itself has allowed NULL since it was added, so
// this checks the actual data rather than assuming the app-level guarantee
// was never violated by an older code path or a manual write.
//
// Never deletes or rewrites a row: if any NULL instrument_id rows exist,
// this reports them and exits without touching the schema. Run again once
// they've been backfilled (or investigated and intentionally left, in
// which case do not run the ALTER at all).
//
// Usage: npx tsx src/scripts/harden-candles-instrument-id.ts
//   --apply     actually run the ALTER TABLE once verification passes
//               (default: dry-run, reports only)

async function main() {
  const apply = process.argv.includes("--apply");

  const { rows: countRows } = await db.execute<{ total: string; null_count: string }>(sql`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE instrument_id IS NULL)::text AS null_count
    FROM candles
  `);

  const total = Number(countRows[0]?.total ?? 0);
  const nullCount = Number(countRows[0]?.null_count ?? 0);

  console.log(JSON.stringify({ totalCandleRows: total, nullInstrumentIdRows: nullCount }, null, 2));

  if (nullCount > 0) {
    const { rows: sample } = await db.execute<{
      id: string;
      exchange: string;
      symbol: string;
      timeframe: string;
      time: string;
    }>(sql`
      SELECT id, exchange, symbol, timeframe, time::text AS time
      FROM candles
      WHERE instrument_id IS NULL
      ORDER BY exchange, symbol, timeframe, time
      LIMIT 50
    `);

    console.log(
      "Verification FAILED — instrument_id is NULL on",
      nullCount,
      "row(s). No schema change made. Sample (up to 50 rows):"
    );
    console.log(JSON.stringify(sample, null, 2));
    console.log(
      "\nThese rows were left untouched. Backfill instrument_id for them " +
        "(e.g. by re-running the relevant backfillDailyCandles calls) and " +
        "re-run this script before adding the NOT NULL constraint."
    );
    process.exit(1);
  }

  console.log(`Verification passed — all ${total} candle row(s) have instrument_id set.`);

  if (!apply) {
    console.log(
      "Dry run only (no --apply flag) — not altering the schema. " +
        "Re-run with --apply to add the NOT NULL constraint now that " +
        "verification has passed."
    );
    process.exit(0);
  }

  await db.execute(sql`ALTER TABLE candles ALTER COLUMN instrument_id SET NOT NULL`);
  console.log("Applied: candles.instrument_id is now NOT NULL.");
  console.log(
    "Next: update instrumentId in market-data.ts's candles table definition " +
      "to .notNull() and run `npx drizzle-kit generate` so the Drizzle " +
      "schema and migration history match the live database (drizzle-kit " +
      "won't detect this out-of-band ALTER on its own)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
