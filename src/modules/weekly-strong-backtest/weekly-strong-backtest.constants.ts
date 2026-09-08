export const CURRENT_MEMBERSHIP = "current_membership" as const;
export const HISTORICAL_MEMBERSHIP = "historical_membership" as const;
export type WeeklyStrongBacktestMembershipMode =
  | typeof CURRENT_MEMBERSHIP
  | typeof HISTORICAL_MEMBERSHIP;

export const UNCLASSIFIED_SECTOR_LABEL = "Unclassified";
export const DASHBOARD_BACKTEST_WEEKS = 250;
