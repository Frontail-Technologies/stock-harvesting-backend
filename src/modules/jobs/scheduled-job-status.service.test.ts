import { beforeEach, describe, expect, it, vi } from "vitest";

const getRepeatableDailyCandleSyncJobs = vi.hoisted(() => vi.fn());
const getLatestBackgroundJobRunByType = vi.hoisted(() => vi.fn());

vi.mock("./queues", () => ({ getRepeatableDailyCandleSyncJobs }));
vi.mock("./background-job-runs.service", () => ({ getLatestBackgroundJobRunByType }));

import { getScheduledDailyCandleSyncStatuses } from "./scheduled-job-status.service";

beforeEach(() => {
  vi.clearAllMocks();
  getLatestBackgroundJobRunByType.mockResolvedValue(new Map());
});

describe("scheduled daily candle status", () => {
  it("reads BullMQ's scheduler key when no id is returned", async () => {
    getRepeatableDailyCandleSyncJobs.mockResolvedValue([
      { key: "repeatable-daily-candle-sync-BSE-morning", name: "daily-candle-sync", next: Date.parse("2026-10-27T04:15:00.000Z") },
      { key: "repeatable-daily-candle-sync-BSE-post-market", name: "daily-candle-sync", next: Date.parse("2026-10-27T10:45:00.000Z") },
    ]);

    expect((await getScheduledDailyCandleSyncStatuses()).map((row) => row.nextRunAt)).toEqual([
      "2026-10-27T04:15:00.000Z",
      "2026-10-27T10:45:00.000Z",
    ]);
  });
});
