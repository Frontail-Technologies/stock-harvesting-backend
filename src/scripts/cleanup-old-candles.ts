import { sql } from "drizzle-orm";

import { db } from "../db/client";

const DEFAULT_CUTOFF_DATE = "2020-01-01";
const DEFAULT_BATCH_SIZE = 25_000;

function getCutoffDate() {
  const value = process.argv[2] ?? DEFAULT_CUTOFF_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Cutoff date must use YYYY-MM-DD format.");
  }

  return value;
}

async function main() {
  const cutoffDate = getCutoffDate();
  let totalDeleted = 0;

  const before = await db.execute(sql`
    select
      exchange,
      timeframe,
      count(*)::int as count,
      min(time)::text as first,
      max(time)::text as last
    from candles
    where time < ${cutoffDate}
    group by exchange, timeframe
    order by count desc
  `);

  console.log(
    JSON.stringify(
      {
        cutoffDate,
        before: before.rows,
      },
      null,
      2
    )
  );

  while (true) {
    const deleted = await db.execute(sql`
      with victims as (
        select id
        from candles
        where time < ${cutoffDate}
        limit ${DEFAULT_BATCH_SIZE}
      ),
      deleted as (
        delete from candles
        using victims
        where candles.id = victims.id
        returning 1
      )
      select count(*)::int as count from deleted
    `);

    const deletedCount = Number(deleted.rows[0]?.count ?? 0);
    totalDeleted += deletedCount;

    console.log(JSON.stringify({ cutoffDate, deletedCount, totalDeleted }));

    if (deletedCount === 0) break;
  }

  const after = await db.execute(sql`
    select
      exchange,
      timeframe,
      count(*)::int as count,
      min(time)::text as first,
      max(time)::text as last
    from candles
    group by exchange, timeframe
    order by exchange, timeframe
  `);

  console.log(
    JSON.stringify(
      {
        cutoffDate,
        totalDeleted,
        after: after.rows,
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
