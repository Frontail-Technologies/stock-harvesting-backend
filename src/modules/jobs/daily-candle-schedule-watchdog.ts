import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { backgroundJobRuns } from "../../db/schema";
import { BACKGROUND_JOB_RUN_STATUS, JOB_NAMES } from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getExchangeTodayIfTradingDay, getLatestExpectedTradingDay } from "../market-data/trading-calendar";
import { listProductionExchanges } from "../market-data/market-data.universe";
import { expectedMarketDataJobsForDate } from "./market-data-job-ledger";
import { addJobWithTimeout, getMarketDataQueue } from "./queues";

const CHECK_INTERVAL_MS = 5 * 60_000;
const START_GRACE_MS = 15 * 60_000;
const MORNING_RECOVERY_WINDOW_MS = 4 * 60 * 60_000;
const POST_MARKET_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;
const LIVE_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

export function isDailyScheduleRecoveryDue(jobType: string, scheduledAt: Date, at: Date) {
  const elapsed = at.getTime() - scheduledAt.getTime();
  const window = jobType === "daily_candle_morning" ? MORNING_RECOVERY_WINDOW_MS : POST_MARKET_RECOVERY_WINDOW_MS;
  return elapsed >= START_GRACE_MS && elapsed < window;
}

async function isLiveJob(jobId: string) {
  const queue = getMarketDataQueue();
  const job = await queue?.getJob(jobId);
  return job ? LIVE_STATES.has(await job.getState()) : false;
}

export async function recoverDueDailyCandleSchedules(at: Date = new Date()) {
  const queue = getMarketDataQueue();
  if (!queue) return;

  for (const exchange of await listProductionExchanges()) {
    const tradingDate = getExchangeTodayIfTradingDay(exchange, at);
    if (!tradingDate) continue;

    for (const expected of expectedMarketDataJobsForDate(exchange, tradingDate)) {
      if (!isDailyScheduleRecoveryDue(expected.jobType, expected.scheduledAt, at)) continue;

      const [run] = await db.select({ status: backgroundJobRuns.status, bullmqJobId: backgroundJobRuns.bullmqJobId })
        .from(backgroundJobRuns)
        .where(and(
          eq(backgroundJobRuns.tradingDate, tradingDate),
          eq(backgroundJobRuns.exchange, exchange),
          eq(backgroundJobRuns.jobType, expected.jobType),
        ))
        .limit(1);
      if (run && run.status !== BACKGROUND_JOB_RUN_STATUS.pending && run.status !== BACKGROUND_JOB_RUN_STATUS.queued) continue;

      const suffix = expected.jobType === "daily_candle_morning" ? "morning" : "post-market";
      const scheduledJobId = `repeat:repeatable-daily-candle-sync-${exchange}-${suffix}:${expected.scheduledAt.getTime()}`;
      const recoveryJobId = `daily-candle-schedule-recovery-${exchange}-${expected.jobType}-${tradingDate}`;
      if (await isLiveJob(scheduledJobId) || await isLiveJob(recoveryJobId)
        || (run?.bullmqJobId && await isLiveJob(run.bullmqJobId))) continue;

      const coverageTradingDate = expected.jobType === "daily_candle_morning"
        ? getLatestExpectedTradingDay(exchange, expected.scheduledAt)
        : tradingDate;
      await addJobWithTimeout(queue, JOB_NAMES.dailyCandleSync, {
        exchange, jobType: expected.jobType, tradingDate, coverageTradingDate,
      }, {
        jobId: recoveryJobId,
        priority: 10,
        attempts: 1,
      });
      logger.warn({ exchange, tradingDate, jobType: expected.jobType, recoveryJobId }, "Recovered missing daily candle schedule");
    }
  }
}

export function startDailyCandleScheduleWatchdog() {
  let inFlight = false;
  const check = () => {
    if (inFlight) return;
    inFlight = true;
    void recoverDueDailyCandleSchedules().catch((error) => {
      logger.error({ message: getErrorMessage(error, "Unknown error") }, "Daily candle schedule watchdog failed");
    }).finally(() => {
      inFlight = false;
    });
  };
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
