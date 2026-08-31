import { pgEnum } from "drizzle-orm/pg-core";

import {
  CANDLE_TIMEFRAMES,
  JOB_STATUSES,
  MONETIZATION_MODES,
  PROVIDER_STATUSES,
  SCAN_RUN_STATUSES,
  USER_PLANS,
  USER_ROLES,
} from "../../shared/constants";

export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const userPlanEnum = pgEnum("user_plan", USER_PLANS);
export const candleTimeframeEnum = pgEnum("candle_timeframe", CANDLE_TIMEFRAMES);
export const providerStatusEnum = pgEnum("provider_status", PROVIDER_STATUSES);
export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);
export const scanRunStatusEnum = pgEnum("scan_run_status", SCAN_RUN_STATUSES);
export const monetizationModeEnum = pgEnum("monetization_mode", MONETIZATION_MODES);
