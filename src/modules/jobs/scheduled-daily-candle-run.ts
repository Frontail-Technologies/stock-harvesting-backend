import { getExchangeTodayIfTradingDay, getLatestExpectedTradingDay } from "../market-data/trading-calendar";

const MAX_SCHEDULED_JOB_AGE_MS = 24 * 60 * 60_000;

export function getScheduledDailyCandleRun(jobId: string | undefined, exchange: string, at: Date = new Date()) {
  const prefix = `repeat:repeatable-daily-candle-sync-${exchange}-`;
  if (!jobId?.startsWith(prefix)) return null;

  const [suffix, timestamp, extra] = jobId.slice(prefix.length).split(":");
  if (extra || (suffix !== "morning" && suffix !== "post-market")) return null;
  const millis = Number(timestamp);
  if (!Number.isSafeInteger(millis) || millis <= 0) return null;

  const scheduledAt = new Date(millis);
  return {
    scheduledAt,
    tradingDate: getExchangeTodayIfTradingDay(exchange, scheduledAt),
    coverageTradingDate: getLatestExpectedTradingDay(exchange, scheduledAt),
    stale: at.getTime() - millis >= MAX_SCHEDULED_JOB_AGE_MS,
  };
}
