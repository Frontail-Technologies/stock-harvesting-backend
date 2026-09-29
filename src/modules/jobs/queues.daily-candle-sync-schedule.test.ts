import { describe, expect, it } from "vitest";

import { BACKGROUND_JOB_TYPES } from "../../shared/constants";
import { DAILY_CANDLE_SYNC_SCHEDULES, DAILY_CANDLE_SYNC_TZ } from "./queues";

describe("DAILY_CANDLE_SYNC_SCHEDULES", () => {
  it("uses Asia/Kolkata for every schedule", () => {
    expect(DAILY_CANDLE_SYNC_TZ).toBe("Asia/Kolkata");
  });

  it("schedules the morning sync at 09:45 IST, Monday-Friday", () => {
    const morning = DAILY_CANDLE_SYNC_SCHEDULES.find((schedule) => schedule.suffix === "morning");
    expect(morning?.pattern).toBe("45 9 * * 1-5");
    expect(morning?.jobType).toBe(BACKGROUND_JOB_TYPES.dailyCandleMorning);
  });

  it("schedules the post-market sync at 16:15 IST, Monday-Friday", () => {
    const postMarket = DAILY_CANDLE_SYNC_SCHEDULES.find((schedule) => schedule.suffix === "post-market");
    expect(postMarket?.pattern).toBe("15 16 * * 1-5");
    expect(postMarket?.jobType).toBe(BACKGROUND_JOB_TYPES.dailyCandlePostMarket);
  });

  it("defines only morning and post-market schedules", () => {
    expect(DAILY_CANDLE_SYNC_SCHEDULES).toHaveLength(2);
    const jobTypes = new Set(DAILY_CANDLE_SYNC_SCHEDULES.map((schedule) => schedule.jobType));
    expect(jobTypes).toEqual(new Set([
      BACKGROUND_JOB_TYPES.dailyCandleMorning,
      BACKGROUND_JOB_TYPES.dailyCandlePostMarket,
    ]));
  });
});
