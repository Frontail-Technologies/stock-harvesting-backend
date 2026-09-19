import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ inserted: [] as unknown[], updates: [] as unknown[] }));
const publishRealtimeEvent = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: {
    insert: () => ({
      values: (values: unknown) => {
        state.inserted.push(values);
        return { returning: async () => [{ id: "run-1" }] };
      },
    }),
    update: () => ({
      set: (values: unknown) => {
        state.updates.push(values);
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock("./realtime-events", () => ({ publishRealtimeEvent }));
vi.mock("./market-data-job-ledger", () => ({ claimMarketDataLedgerRun: vi.fn() }));

import { BACKGROUND_JOB_RUN_STATUS, BACKGROUND_JOB_TYPES } from "../../shared/constants";
import { recordScheduledJobRun } from "./background-job-runs.service";

beforeEach(() => {
  vi.clearAllMocks();
  state.inserted = [];
  state.updates = [];
});

describe("recordScheduledJobRun", () => {
  it("records a running row, then completes it with the scalar parts of the result", async () => {
    const result = await recordScheduledJobRun(
      { jobType: BACKGROUND_JOB_TYPES.instrumentSync, exchange: "BSE", bullmqJobId: "repeat:abc:1", hasSyncJob: false },
      async () => ({ count: 5640, failedSymbols: ["A", "B"] }),
    );

    expect(result).toEqual({ count: 5640, failedSymbols: ["A", "B"] });
    expect(state.inserted[0]).toMatchObject({
      jobType: "instrument_sync",
      exchange: "BSE",
      bullmqJobId: "repeat:abc:1",
      status: BACKGROUND_JOB_RUN_STATUS.running,
    });
    expect(state.updates.at(-1)).toMatchObject({
      status: BACKGROUND_JOB_RUN_STATUS.completed,
      metadata: { result: { count: 5640 } },
    });
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ type: "market-data:job-started" }) }),
    );
  });

  it("marks the run failed and rethrows when the job throws", async () => {
    await expect(
      recordScheduledJobRun(
        { jobType: BACKGROUND_JOB_TYPES.candleBootstrapReconcile, exchange: "BSE", hasSyncJob: false },
        async () => {
          throw new Error("Query read timeout");
        },
      ),
    ).rejects.toThrow("Query read timeout");

    expect(state.updates.at(-1)).toMatchObject({
      status: BACKGROUND_JOB_RUN_STATUS.failed,
      errorSummary: "Query read timeout",
    });
  });

  it("does not record a second row for a job started from the admin (it already has a sync_jobs row)", async () => {
    const result = await recordScheduledJobRun(
      { jobType: BACKGROUND_JOB_TYPES.instrumentSync, exchange: "BSE", hasSyncJob: true },
      async () => "done",
    );

    expect(result).toBe("done");
    expect(state.inserted).toHaveLength(0);
  });
});
