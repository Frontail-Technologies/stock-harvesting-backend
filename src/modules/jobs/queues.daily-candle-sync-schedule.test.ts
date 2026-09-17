import { describe, expect, it } from "vitest";

import { BACKGROUND_JOB_TYPES } from "../../shared/constants";
import { DAILY_CANDLE_SYNC_SCHEDULES, DAILY_CANDLE_SYNC_TZ } from "./queues";

describe("DAILY_CANDLE_SYNC_SCHEDULES", () => {
  it("uses Asia/Kolkata for every schedule", () => {
    expect(DAILY_CANDLE_SYNC_TZ).toBe("Asia/Kolkata");
  });

  it("schedules the morning sync at 09:40 IST, Monday-Friday", () => {
    const morning = DAILY_CANDLE_SYNC_SCHEDULES.find((schedule) => schedule.suffix === "morning");
    expect(morning?.pattern).toBe("40 9 * * 1-5");
    expect(morning?.jobType).toBe(BACKGROUND_JOB_TYPES.dailyCandleMorning);
  });

  it("schedules the post-market sync at 15:50 IST, Monday-Friday", () => {
    const postMarket = DAILY_CANDLE_SYNC_SCHEDULES.find((schedule) => schedule.suffix === "post-market");
    expect(postMarket?.pattern).toBe("50 15 * * 1-5");
    expect(postMarket?.jobType).toBe(BACKGROUND_JOB_TYPES.dailyCandlePostMarket);
  });

  it("schedules the retry sync at 17:00 IST, Monday-Friday", () => {
    const retry = DAILY_CANDLE_SYNC_SCHEDULES.find((schedule) => schedule.suffix === "retry");
    expect(retry?.pattern).toBe("0 17 * * 1-5");
    expect(retry?.jobType).toBe(BACKGROUND_JOB_TYPES.dailyCandleRetry);
  });

  it("schedules the evening sync at 20:00 IST, Monday-Friday - a later catch-up for symbols the 17:00 retry missed because GDF's own settling window runs through 8 PM", () => {
    const evening = DAILY_CANDLE_SYNC_SCHEDULES.find((schedule) => schedule.suffix === "evening");
    expect(evening?.pattern).toBe("0 20 * * 1-5");
    expect(evening?.jobType).toBe(BACKGROUND_JOB_TYPES.dailyCandleEvening);
  });

  it("defines exactly four schedules, one per job type", () => {
    expect(DAILY_CANDLE_SYNC_SCHEDULES).toHaveLength(4);
    const jobTypes = new Set(DAILY_CANDLE_SYNC_SCHEDULES.map((schedule) => schedule.jobType));
    expect(jobTypes.size).toBe(4);
  });
});
