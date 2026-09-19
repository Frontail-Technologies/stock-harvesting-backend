import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { backgroundJobRuns, candles, instruments } from "../../db/schema";
import {
  BACKGROUND_JOB_RUN_STATUS,
  BACKGROUND_JOB_TYPES,
  CANDLE_TIMEFRAME,
  JOB_NAMES,
  type BackgroundJobType,
} from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { reconcileWeeklyStrongBacktests } from "../weekly-strong-backtest/weekly-strong-backtest.reconciliation";
import { activeUniverseFilter, listProductionExchanges } from "../market-data/market-data.universe";
import {
  getExchangeTodayIfTradingDay,
  getLatestExpectedTradingDay,
} from "../market-data/trading-calendar";
import { listNoHistorySymbols } from "../market-data/market-data.no-history";
import { addJobWithTimeout, getMarketDataQueue } from "./queues";

const EXPECTED_SCHEDULES = [
  { jobType: BACKGROUND_JOB_TYPES.dailyCandleMorning, time: "09:40" },
  { jobType: BACKGROUND_JOB_TYPES.dailyCandlePostMarket, time: "15:50" },
  { jobType: BACKGROUND_JOB_TYPES.dailyCandleRetry, time: "17:00" },
] as const;

const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
const MISSED_JOB_GRACE_MS = 15 * 60 * 1000;
let reconciliationTimer: NodeJS.Timeout | null = null;

export class MarketDataLedgerRunNotClaimableError extends Error {}

export function calculateHistoricalCoverage(
  universe: Array<{
    instrumentId: string;
    symbol: string;
    firstCandleDate?: string | null;
    productionEligible?: boolean;
  }>,
  presentInstrumentIds: Iterable<string>,
  options?: { tradingDate?: string; exemptSymbols?: Iterable<string> },
) {
  const presentIds = new Set(presentInstrumentIds);
  const exemptSymbols = new Set(options?.exemptSymbols ?? []);
  const expectedUniverse = universe.filter((row) => {
    if (row.productionEligible === false || exemptSymbols.has(row.symbol)) return false;
    return !options?.tradingDate || !row.firstCandleDate || row.firstCandleDate <= options.tradingDate;
  });
  const missingSymbols = expectedUniverse
    .filter((row) => !presentIds.has(row.instrumentId))
    .map((row) => row.symbol);
  const completed = expectedUniverse.length - missingSymbols.length;
  return {
    totalExpected: expectedUniverse.length,
    completed,
    missing: missingSymbols.length,
    coveragePct: expectedUniverse.length === 0 ? 0 : Math.round((completed / expectedUniverse.length) * 10_000) / 100,
    missingSymbols,
    exempt: universe.length - expectedUniverse.length,
  };
}

export function isExpectedJobMissed(status: string, scheduledAt: Date, at: Date) {
  return (
    (status === BACKGROUND_JOB_RUN_STATUS.pending || status === BACKGROUND_JOB_RUN_STATUS.queued)
    && scheduledAt.getTime() < at.getTime() - MISSED_JOB_GRACE_MS
  );
}

function scheduledAtForIndiaDate(date: string, time: string) {
  return new Date(`${date}T${time}:00+05:30`);
}

export function expectedMarketDataJobsForDate(exchange: string, tradingDate: string) {
  return EXPECTED_SCHEDULES.map((schedule) => ({
    tradingDate,
    exchange,
    jobType: schedule.jobType,
    scheduledAt: scheduledAtForIndiaDate(tradingDate, schedule.time),
    status: BACKGROUND_JOB_RUN_STATUS.pending,
  }));
}

export function shouldQueueHistoricalCatchUp(coverage: { missing: number }) {
  return coverage.missing > 0;
}

export async function ensureExpectedMarketDataJobs(
  at: Date = new Date(),
  exchanges?: string[],
) {
  const productionExchanges = exchanges ?? (await listProductionExchanges());
  let created = 0;

  for (const exchange of productionExchanges) {
    const dates = new Set<string>([getLatestExpectedTradingDay(exchange, at)]);
    const today = getExchangeTodayIfTradingDay(exchange, at);
    if (today) dates.add(today);

    for (const tradingDate of dates) {
      for (const expectedJob of expectedMarketDataJobsForDate(exchange, tradingDate)) {
        const rows = await db
          .insert(backgroundJobRuns)
          .values(expectedJob)
          .onConflictDoNothing()
          .returning({ id: backgroundJobRuns.id });
        created += rows.length;
      }
    }
  }

  return { created, exchanges: productionExchanges };
}

export async function markExpectedMarketDataJobsQueued(exchanges: string[]) {
  if (exchanges.length === 0) return 0;
  const rows = await db
    .update(backgroundJobRuns)
    .set({ status: BACKGROUND_JOB_RUN_STATUS.queued, updatedAt: new Date() })
    .where(and(
      eq(backgroundJobRuns.status, BACKGROUND_JOB_RUN_STATUS.pending),
      inArray(backgroundJobRuns.exchange, exchanges),
      inArray(backgroundJobRuns.jobType, EXPECTED_SCHEDULES.map((entry) => entry.jobType)),
    ))
    .returning({ id: backgroundJobRuns.id });
  return rows.length;
}

export async function getHistoricalCoverage(exchange: string, tradingDate: string) {
  const universe = await db
    .select({ instrumentId: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(activeUniverseFilter(exchange));
  const instrumentIds = universe.map((row) => row.instrumentId);
  if (instrumentIds.length === 0) {
    return { tradingDate, exchange, totalExpected: 0, completed: 0, missing: 0, coveragePct: 0, missingSymbols: [], exempt: 0 };
  }

  const [present, exemptionRows, noHistorySymbols] = await Promise.all([
    db
      .select({ instrumentId: candles.instrumentId })
      .from(candles)
      .where(and(
        inArray(candles.instrumentId, instrumentIds),
        eq(candles.timeframe, CANDLE_TIMEFRAME.day),
        eq(candles.time, tradingDate),
      )),
    db
      .select({ metadata: backgroundJobRuns.metadata })
      .from(backgroundJobRuns)
      .where(and(
        eq(backgroundJobRuns.exchange, exchange),
        eq(backgroundJobRuns.tradingDate, tradingDate),
        eq(backgroundJobRuns.jobType, BACKGROUND_JOB_TYPES.dailyCandleCatchUp),
      )),
    listNoHistorySymbols(exchange),
  ]);
  // Exempt = GlobalDataFeeds confirmed it has no history for the instrument (successful
  // empty response). Provider errors, timeouts and persistence failures never land here,
  // so those instruments stay counted as missing.
  const exemptSymbols = [
    ...exemptionRows.flatMap((row) => {
      const value = row.metadata.coverageExemptSymbols;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    }),
    ...noHistorySymbols,
  ];
  const calculated = calculateHistoricalCoverage(
    universe,
    present.map((row) => row.instrumentId),
    { tradingDate, exemptSymbols },
  );

  return {
    tradingDate,
    exchange,
    ...calculated,
  };
}

const LIVE_BULLMQ_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

// True while BullMQ still holds the job in a state where it will run (or is running) - jobs are removed
// on completion/failure, so a missing job means nothing is going to process the ledger row.
export async function hasLiveCatchUpJob(
  queue: { getJob: (jobId: string) => Promise<{ getState: () => Promise<string> } | undefined | null> },
  jobId: string,
) {
  const job = await queue.getJob(jobId);
  if (!job) return false;
  return LIVE_BULLMQ_STATES.has(await job.getState());
}

export async function createAndQueueCatchUp(
  exchange: string,
  tradingDate: string,
  symbols?: string[],
  options?: { force?: boolean },
) {
  const targetSymbols = symbols ?? (await getHistoricalCoverage(exchange, tradingDate)).missingSymbols;
  if (targetSymbols.length === 0) return null;
  const scheduledAt = new Date();
  const [ledger] = await db
    .insert(backgroundJobRuns)
    .values({
      tradingDate,
      exchange,
      jobType: BACKGROUND_JOB_TYPES.dailyCandleCatchUp,
      scheduledAt,
      status: BACKGROUND_JOB_RUN_STATUS.pending,
      totalExpected: targetSymbols.length,
      missingCount: targetSymbols.length,
      metadata: { targetSymbols },
    })
    .onConflictDoNothing()
    .returning({ id: backgroundJobRuns.id });

  const [existing] = ledger
    ? [{ ...ledger, status: BACKGROUND_JOB_RUN_STATUS.pending }]
    : await db
        .select({ id: backgroundJobRuns.id, status: backgroundJobRuns.status, attemptCount: backgroundJobRuns.attemptCount })
        .from(backgroundJobRuns)
        .where(
          and(
            eq(backgroundJobRuns.tradingDate, tradingDate),
            eq(backgroundJobRuns.exchange, exchange),
            eq(backgroundJobRuns.jobType, BACKGROUND_JOB_TYPES.dailyCandleCatchUp),
          ),
        )
        .limit(1);
  if (!existing) return null;
  const retryableStatuses = new Set<string>([
    BACKGROUND_JOB_RUN_STATUS.pending,
    BACKGROUND_JOB_RUN_STATUS.failed,
    BACKGROUND_JOB_RUN_STATUS.partial,
    BACKGROUND_JOB_RUN_STATUS.missed,
  ]);
  const bullmqJobId = `market-data-catch-up:${exchange}:${tradingDate}`;
  if (!ledger && !retryableStatuses.has(existing.status)) {
    // A run marked queued/running is only really in progress while its BullMQ job exists. If the job is
    // gone (queue cleared, Redis restarted) the run is orphaned and would stay "queued" forever, so it
    // is enqueued again instead of being skipped.
    const mayBeOrphaned =
      existing.status === BACKGROUND_JOB_RUN_STATUS.queued || existing.status === BACKGROUND_JOB_RUN_STATUS.running;
    if (!mayBeOrphaned) return existing.id;
    const orphanCheckQueue = getMarketDataQueue();
    if (!orphanCheckQueue || (await hasLiveCatchUpJob(orphanCheckQueue, bullmqJobId))) return existing.id;
  }
  if (!ledger && "attemptCount" in existing && existing.attemptCount >= 3 && !options?.force) return existing.id;

  const queue = getMarketDataQueue();
  if (!queue) return existing.id;
  try {
    await addJobWithTimeout(
      queue,
      JOB_NAMES.marketDataCatchUp,
      { exchange, tradingDate, symbols: targetSymbols, ledgerRunId: existing.id },
      { jobId: bullmqJobId, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
    );
    await db
      .update(backgroundJobRuns)
      .set({ status: BACKGROUND_JOB_RUN_STATUS.queued, bullmqJobId, updatedAt: new Date() })
      .where(eq(backgroundJobRuns.id, existing.id));
  } catch (error) {
    await db
      .update(backgroundJobRuns)
      .set({ errorSummary: getErrorMessage(error, "Catch-up enqueue failed"), updatedAt: new Date() })
      .where(eq(backgroundJobRuns.id, existing.id));
  }
  return existing.id;
}

export async function reconcileMarketDataJobLedger(at: Date = new Date()) {
  const { exchanges } = await ensureExpectedMarketDataJobs(at);
  const missedRows = await db
    .update(backgroundJobRuns)
    .set({ status: BACKGROUND_JOB_RUN_STATUS.missed, updatedAt: new Date() })
    .where(
      and(
        inArray(backgroundJobRuns.status, [BACKGROUND_JOB_RUN_STATUS.pending, BACKGROUND_JOB_RUN_STATUS.queued]),
        inArray(backgroundJobRuns.jobType, EXPECTED_SCHEDULES.map((entry) => entry.jobType)),
        lt(backgroundJobRuns.scheduledAt, new Date(at.getTime() - MISSED_JOB_GRACE_MS)),
      ),
    )
    .returning({ tradingDate: backgroundJobRuns.tradingDate, exchange: backgroundJobRuns.exchange });

  const targets = new Map<string, { exchange: string; tradingDate: string }>();
  for (const exchange of exchanges) {
    const tradingDate = getLatestExpectedTradingDay(exchange, at);
    targets.set(`${exchange}:${tradingDate}`, { exchange, tradingDate });
  }
  for (const row of missedRows) {
    if (row.exchange && row.tradingDate) {
      targets.set(`${row.exchange}:${row.tradingDate}`, { exchange: row.exchange, tradingDate: row.tradingDate });
    }
  }

  for (const target of targets.values()) {
    const coverage = await getHistoricalCoverage(target.exchange, target.tradingDate);
    if (shouldQueueHistoricalCatchUp(coverage)) {
      await createAndQueueCatchUp(target.exchange, target.tradingDate, coverage.missingSymbols);
    }
  }

  return { missed: missedRows.length, targets: targets.size };
}

export async function finishLedgerCoverage(input: {
  runId: string;
  exchange: string;
  tradingDate: string;
  coverageExemptSymbols?: string[];
}) {
  if (input.coverageExemptSymbols?.length) {
    const [current] = await db
      .select({ metadata: backgroundJobRuns.metadata })
      .from(backgroundJobRuns)
      .where(eq(backgroundJobRuns.id, input.runId))
      .limit(1);
    await db
      .update(backgroundJobRuns)
      .set({
        metadata: { ...(current?.metadata ?? {}), coverageExemptSymbols: input.coverageExemptSymbols },
        updatedAt: new Date(),
      })
      .where(eq(backgroundJobRuns.id, input.runId));
  }
  const coverage = await getHistoricalCoverage(input.exchange, input.tradingDate);
  const status = coverage.missing === 0 ? BACKGROUND_JOB_RUN_STATUS.completed : BACKGROUND_JOB_RUN_STATUS.partial;
  await db
    .update(backgroundJobRuns)
    .set({
      status,
      totalExpected: coverage.totalExpected,
      completedCount: coverage.completed,
      missingCount: coverage.missing,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(backgroundJobRuns.id, input.runId));

  if (coverage.missing === 0) {
    const [alreadyCurrent] = await db
      .select({ id: backgroundJobRuns.id })
      .from(backgroundJobRuns)
      .where(and(
        eq(backgroundJobRuns.exchange, input.exchange),
        eq(backgroundJobRuns.backtestStatus, "completed"),
        gte(backgroundJobRuns.backtestThrough, input.tradingDate),
      ))
      .limit(1);
    if (alreadyCurrent) {
      await db
        .update(backgroundJobRuns)
        .set({ backtestStatus: "completed", backtestThrough: input.tradingDate, updatedAt: new Date() })
        .where(eq(backgroundJobRuns.id, input.runId));
      return coverage;
    }
    try {
      await reconcileWeeklyStrongBacktests(input.exchange);
      await db
        .update(backgroundJobRuns)
        .set({ backtestStatus: "completed", backtestThrough: input.tradingDate, updatedAt: new Date() })
        .where(eq(backgroundJobRuns.id, input.runId));
    } catch (error) {
      await db
        .update(backgroundJobRuns)
        .set({ backtestStatus: "failed", errorSummary: getErrorMessage(error, "Backtest refresh failed"), updatedAt: new Date() })
        .where(eq(backgroundJobRuns.id, input.runId));
    }
  }

  return coverage;
}

export async function listMarketDataLedger(limit = 50) {
  return db
    .select()
    .from(backgroundJobRuns)
    .where(sql`${backgroundJobRuns.tradingDate} is not null`)
    .orderBy(desc(backgroundJobRuns.scheduledAt))
    .limit(limit);
}

export async function getMarketDataOperations(at: Date = new Date()) {
  const exchanges = await listProductionExchanges();
  const coverageGroups = await Promise.all(exchanges.map(async (exchange) => {
    const tradingDate = getLatestExpectedTradingDay(exchange, at);
    const universe = await db
      .select({ instrumentId: instruments.id })
      .from(instruments)
      .where(activeUniverseFilter(exchange));
    const ids = universe.map((row) => row.instrumentId);
    const recentDates = ids.length === 0
      ? []
      : await db
          .selectDistinct({ date: candles.time })
          .from(candles)
          .where(and(
            inArray(candles.instrumentId, ids),
            eq(candles.timeframe, CANDLE_TIMEFRAME.day),
            lte(candles.time, tradingDate),
          ))
          .orderBy(desc(candles.time))
          .limit(4);
    const dates = [...new Set([tradingDate, ...recentDates.map((row) => row.date)])];
    return Promise.all(dates.map((date) => getHistoricalCoverage(exchange, date)));
  }));
  const coverage = coverageGroups.flat();
  const historicalThrough = coverage.find((row) => row.totalExpected > 0 && row.missing === 0)?.tradingDate ?? null;
  const [backtest] = await db
    .select({ through: sql<string | null>`max(${backgroundJobRuns.backtestThrough})` })
    .from(backgroundJobRuns)
    .where(eq(backgroundJobRuns.backtestStatus, "completed"));
  return {
    checkedAt: at,
    expectedCompletedTradingDate: coverage[0]?.tradingDate ?? null,
    historicalThrough,
    backtestsThrough: backtest?.through ?? null,
    productionProvider: "GlobalDataFeeds",
    coverage,
    jobs: await listMarketDataLedger(100),
  };
}

// Backtests may only be marked current for a date whose historical data is
// complete, and there is nothing to refresh when they already reach that date.
export function decideBacktestRefresh(input: {
  coverage: { totalExpected: number; missing: number };
  backtestsThrough: string | null;
  tradingDate: string;
}): "historical-incomplete" | "already-current" | "refresh" {
  if (input.coverage.totalExpected === 0 || input.coverage.missing > 0) return "historical-incomplete";
  if (input.backtestsThrough !== null && input.backtestsThrough >= input.tradingDate) return "already-current";
  return "refresh";
}

export async function refreshMarketDataBacktests(exchange: string, tradingDate: string) {
  const [coverage, [current]] = await Promise.all([
    getHistoricalCoverage(exchange, tradingDate),
    db
      .select({ through: sql<string | null>`max(${backgroundJobRuns.backtestThrough})` })
      .from(backgroundJobRuns)
      .where(and(eq(backgroundJobRuns.exchange, exchange), eq(backgroundJobRuns.backtestStatus, "completed"))),
  ]);
  const backtestsThrough = current?.through ?? null;
  const decision = decideBacktestRefresh({ coverage, backtestsThrough, tradingDate });
  if (decision !== "refresh") return { exchange, tradingDate, refreshed: false, reason: decision, backtestsThrough };

  await reconcileWeeklyStrongBacktests(exchange);
  await db
    .update(backgroundJobRuns)
    .set({ backtestStatus: "completed", backtestThrough: tradingDate, updatedAt: new Date() })
    .where(and(eq(backgroundJobRuns.exchange, exchange), eq(backgroundJobRuns.tradingDate, tradingDate)));
  return { exchange, tradingDate, refreshed: true, reason: null, backtestsThrough: tradingDate };
}

export async function claimMarketDataLedgerRun(input: {
  jobType: BackgroundJobType;
  exchange: string;
  bullmqJobId?: string;
  ledgerRunId?: string;
  tradingDate?: string;
}) {
  const now = new Date();
  const tradingDate = input.tradingDate
    ?? getExchangeTodayIfTradingDay(input.exchange, now)
    ?? getLatestExpectedTradingDay(input.exchange, now);
  await ensureExpectedMarketDataJobs(now, [input.exchange]);

  const [row] = input.ledgerRunId
    ? await db.select({ id: backgroundJobRuns.id }).from(backgroundJobRuns).where(eq(backgroundJobRuns.id, input.ledgerRunId)).limit(1)
    : await db
        .select({ id: backgroundJobRuns.id, status: backgroundJobRuns.status })
        .from(backgroundJobRuns)
        .where(and(
          eq(backgroundJobRuns.tradingDate, tradingDate),
          eq(backgroundJobRuns.exchange, input.exchange),
          eq(backgroundJobRuns.jobType, input.jobType),
        ))
        .limit(1);
  if (!row) throw new Error(`Expected market-data job is missing for ${input.exchange} ${tradingDate} ${input.jobType}`);
  const [fullRow] = "status" in row
    ? [row]
    : await db.select({ id: backgroundJobRuns.id, status: backgroundJobRuns.status }).from(backgroundJobRuns).where(eq(backgroundJobRuns.id, row.id)).limit(1);
  if (!fullRow || fullRow.status === BACKGROUND_JOB_RUN_STATUS.missed || fullRow.status === BACKGROUND_JOB_RUN_STATUS.completed) {
    throw new MarketDataLedgerRunNotClaimableError(`Market-data job ${row.id} is already ${fullRow?.status ?? "missing"}`);
  }

  await db
    .update(backgroundJobRuns)
    .set({
      status: BACKGROUND_JOB_RUN_STATUS.running,
      startedAt: now,
      finishedAt: null,
      bullmqJobId: input.bullmqJobId,
      attemptCount: sql`${backgroundJobRuns.attemptCount} + 1`,
      errorSummary: null,
      updatedAt: now,
    })
    .where(eq(backgroundJobRuns.id, row.id));
  return { runId: row.id, tradingDate };
}

export function startMarketDataLedgerReconciliation() {
  if (reconciliationTimer) return;
  void reconcileMarketDataJobLedger().catch((error) => {
    logger.error({ message: getErrorMessage(error, "Ledger reconciliation failed") }, "Market-data ledger reconciliation failed");
  });
  reconciliationTimer = setInterval(() => {
    void reconcileMarketDataJobLedger().catch((error) => {
      logger.error({ message: getErrorMessage(error, "Ledger reconciliation failed") }, "Market-data ledger reconciliation failed");
    });
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();
}
