// Exchange-aware trading-day/week completion helpers - timezone, market close, and weekends are handled; holidays are not modeled.

import { getWeekKey } from "./candle-aggregation";

const INDIA_EXCHANGE_PREFIXES = ["NSE", "BSE"];

function isIndiaExchange(exchange: string) {
  return INDIA_EXCHANGE_PREFIXES.some((prefix) => exchange.startsWith(prefix));
}

// Falls back to US market hours for every non-India exchange - not a real per-market timezone table, just enough to avoid treating every exchange as UTC-midnight.
function getExchangeTimeZone(exchange: string): string {
  return isIndiaExchange(exchange) ? "Asia/Kolkata" : "America/New_York";
}

function getExchangeMarketClose(exchange: string) {
  return isIndiaExchange(exchange) ? { hour: 15, minute: 30 } : { hour: 16, minute: 0 };
}

const WEEKDAY_BY_SHORT_NAME: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getExchangeLocalParts(exchange: string, at: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: getExchangeTimeZone(exchange),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(at);
  const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(lookup("hour"));

  return {
    date: `${lookup("year")}-${lookup("month")}-${lookup("day")}`,
    weekday: WEEKDAY_BY_SHORT_NAME[lookup("weekday")] ?? 0,
    // Some ICU implementations report midnight as "24" under hour12: false.
    hour: hour === 24 ? 0 : hour,
    minute: Number(lookup("minute")),
  };
}

function shiftDateString(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return utcDate.toISOString().slice(0, 10);
}

// Returns the latest trading day (YYYY-MM-DD, exchange-local) expected to have a completed daily candle. Weekends are skipped; "today" only counts once market close has passed, otherwise the prior trading day is used.
export function getLatestExpectedTradingDay(exchange: string, at: Date = new Date()): string {
  const local = getExchangeLocalParts(exchange, at);
  const marketClose = getExchangeMarketClose(exchange);
  const isAfterClose =
    local.hour > marketClose.hour ||
    (local.hour === marketClose.hour && local.minute >= marketClose.minute);

  let candidateDate = local.date;
  let candidateWeekday = local.weekday;
  if (!isAfterClose) {
    candidateDate = shiftDateString(candidateDate, -1);
    candidateWeekday = (candidateWeekday + 6) % 7;
  }

  while (candidateWeekday === 0 || candidateWeekday === 6) {
    candidateDate = shiftDateString(candidateDate, -1);
    candidateWeekday = (candidateWeekday + 6) % 7;
  }

  return candidateDate;
}

// A week is complete once it's earlier than the ISO week containing the exchange's latest expected completed trading day. Shared by the whole Weekly Strong pipeline via weekly-strong-evaluator.ts's excludeIncompleteTradingWeek.
export function isCompletedTradingWeek(
  weekCandleTime: string,
  exchange: string,
  at: Date = new Date()
): boolean {
  const latestCompletedDay = getLatestExpectedTradingDay(exchange, at);
  return (
    getWeekKey(new Date(`${weekCandleTime}T00:00:00.000Z`)) !==
    getWeekKey(new Date(`${latestCompletedDay}T00:00:00.000Z`))
  );
}

// The Monday-Sunday (UTC) ISO week range containing `dateStr`, as a date pair rather than getWeekKey's "YYYY-Www" string - lets a stored date be matched by range instead of predicting its exact value, since a weekly candle's stored `time` can legitimately fall anywhere in this range, not always on the Monday.
export function getIsoWeekRange(dateStr: string): { start: string; end: string } {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const isoDay = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - (isoDay - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

// The canonical, product-facing label for the ISO week containing `dateStr`: that week's Friday. Weekly Harvest/Backtest results are always identified by this week-ending date, never the week's Monday - a pure relabeling, not a completeness decision, so it's safe to apply to any date.
export function getWeekEndingFriday(dateStr: string): string {
  const { start } = getIsoWeekRange(dateStr);
  return shiftDateString(start, 4);
}

// The week-ending Friday of the latest COMPLETED week, given a "latest expected trading day" value - the Friday of the ISO week immediately before the one containing that trading day, reusing isCompletedTradingWeek's exact rule so the latest completed week is always exactly one calendar week behind, same cadence as the (unmodified) Weekly Strong evaluator and Backtest incremental sync. Pure and stateless - depends only on the trading day passed in, so it reproduces the exact week the original computation used even when reapplied to an already-persisted value at read time.
export function resolveCompletedWeekEndingFromTradingDay(latestExpectedTradingDay: string): string {
  const currentWeekFriday = getWeekEndingFriday(latestExpectedTradingDay);
  return shiftDateString(currentWeekFriday, -7);
}

export function resolveLatestCompletedWeekEnding(exchange: string, at: Date = new Date()): string {
  return resolveCompletedWeekEndingFromTradingDay(getLatestExpectedTradingDay(exchange, at));
}
