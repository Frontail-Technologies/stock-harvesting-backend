import { shiftDateByDays } from "./market-data.dates";

export const INCREMENTAL_OVERLAP_TRADING_DAYS = 5;
export const RECENT_REPAIR_WINDOW_CALENDAR_DAYS = 35;

export type DailyCandleSyncPlan =
  | { kind: "bootstrap-required" }
  | { kind: "range"; from: string; to: string; repairTriggered: boolean };

export function planDailyCandleSync(input: {
  latestStoredDate: string | null;
  latestExpectedTradingDate: string;
}): DailyCandleSyncPlan {
  const { latestStoredDate, latestExpectedTradingDate: to } = input;

  if (!latestStoredDate) return { kind: "bootstrap-required" };

  const incrementalFrom = shiftDateByDays(latestStoredDate, -INCREMENTAL_OVERLAP_TRADING_DAYS);
  const repairFrom = shiftDateByDays(to, -RECENT_REPAIR_WINDOW_CALENDAR_DAYS);
  const finalFrom = incrementalFrom < repairFrom ? incrementalFrom : repairFrom;
  const repairTriggered = finalFrom === repairFrom && repairFrom < incrementalFrom;

  return { kind: "range", from: finalFrom, to, repairTriggered };
}
