import { eq } from "drizzle-orm";

import { db, pool } from "../db/client";
import { backgroundJobRuns } from "../db/schema";
import {
  BACKGROUND_JOB_RUN_STATUS,
  BACKGROUND_JOB_TYPES,
  JOB_NAMES,
} from "../shared/constants";
import { listInstrumentSyncExchanges, listProductionExchanges } from "../modules/market-data/market-data.universe";
import {
  addJobWithTimeout,
  closeQueues,
  getMarketDataQueue,
  scheduleCandleBootstrapReconciliation,
  scheduleRepeatableDailyCandleSync,
  scheduleRepeatableMarketDataSync,
} from "../modules/jobs/queues";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function indiaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main() {
  if (!process.argv.includes("--confirm-reset")) {
    throw new Error("Refusing to clear jobs without --confirm-reset");
  }

  const tradingDate = argument("--date") ?? indiaDate();
  const exchange = (argument("--exchange") ?? "BSE").toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    throw new Error(`Invalid --date: ${tradingDate}`);
  }

  const queue = getMarketDataQueue();
  if (!queue) throw new Error("Redis queue unavailable");

  // This is an operator-only clean slate. Stop the worker before running it so
  // no active provider request survives while BullMQ state is removed.
  await queue.obliterate({ force: true });
  await db.delete(backgroundJobRuns);

  const [instrumentExchanges, productionExchanges] = await Promise.all([
    listInstrumentSyncExchanges(),
    listProductionExchanges(),
  ]);
  const schedulesStartAt = new Date(new Date(`${tradingDate}T00:00:00+05:30`).getTime() + 24 * 60 * 60 * 1000);
  const scheduleOptions = { startDate: schedulesStartAt };
  await scheduleRepeatableMarketDataSync(instrumentExchanges, scheduleOptions);
  await scheduleRepeatableDailyCandleSync(productionExchanges, scheduleOptions);
  await scheduleCandleBootstrapReconciliation(productionExchanges, scheduleOptions);

  const jobId = `manual-daily-candle-sync:${exchange}:${tradingDate}`;
  const [run] = await db.insert(backgroundJobRuns).values({
    tradingDate,
    exchange,
    jobType: BACKGROUND_JOB_TYPES.dailyCandlePostMarket,
    scheduledAt: new Date(),
    status: BACKGROUND_JOB_RUN_STATUS.queued,
    bullmqJobId: jobId,
  }).returning({ id: backgroundJobRuns.id });

  try {
    await addJobWithTimeout(
      queue,
      JOB_NAMES.dailyCandleSync,
      { exchange, jobType: BACKGROUND_JOB_TYPES.dailyCandlePostMarket },
      { jobId, attempts: 1 },
    );
  } catch (error) {
    await db.delete(backgroundJobRuns).where(eq(backgroundJobRuns.id, run.id));
    throw error;
  }

  console.log(JSON.stringify({
    cleared: true,
    schedulesStartAt: schedulesStartAt.toISOString(),
    queued: { jobId, runId: run.id, exchange, tradingDate },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await pool.end();
  });
