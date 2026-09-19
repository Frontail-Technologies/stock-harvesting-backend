import { beforeEach, describe, expect, it, vi } from "vitest";

// A catch-up run marked "queued"/"running" is only really in progress while its BullMQ job exists.
// Jobs are removed on completion, and a cleared queue or restarted Redis leaves the ledger row
// "queued" forever - clicking "Refresh candles" then did nothing. These tests pin the orphan handling.

const state = vi.hoisted(() => ({
  existingRow: null as null | { id: string; status: string; attemptCount: number },
  updates: [] as unknown[],
}));
const addJobWithTimeout = vi.hoisted(() => vi.fn());
const getJob = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (state.existingRow ? [state.existingRow] : []) }) }),
    }),
    update: () => ({
      set: (values: unknown) => {
        state.updates.push(values);
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock("./queues", () => ({
  getMarketDataQueue: () => ({ getJob }),
  addJobWithTimeout,
}));

import { BACKGROUND_JOB_RUN_STATUS } from "../../shared/constants";
import { createAndQueueCatchUp, hasLiveCatchUpJob } from "./market-data-job-ledger";

const JOB_ID = "market-data-catch-up:BSE:2026-09-18";

function existing(status: string, attemptCount = 0) {
  state.existingRow = { id: "run-1", status, attemptCount };
}
const liveJob = (jobState: string) => ({ getState: async () => jobState });

beforeEach(() => {
  vi.clearAllMocks();
  state.updates = [];
  addJobWithTimeout.mockResolvedValue(undefined);
});

describe("hasLiveCatchUpJob", () => {
  it.each(["waiting", "active", "delayed", "prioritized"])("treats a %s job as live", async (jobState) => {
    await expect(hasLiveCatchUpJob({ getJob: async () => liveJob(jobState) }, JOB_ID)).resolves.toBe(true);
  });

  it("treats a missing job as not live", async () => {
    await expect(hasLiveCatchUpJob({ getJob: async () => undefined }, JOB_ID)).resolves.toBe(false);
  });

  it.each(["completed", "failed", "unknown"])("treats a %s job as not live", async (jobState) => {
    await expect(hasLiveCatchUpJob({ getJob: async () => liveJob(jobState) }, JOB_ID)).resolves.toBe(false);
  });
});

describe("createAndQueueCatchUp with an existing ledger row", () => {
  it("re-enqueues a queued run whose BullMQ job no longer exists (orphaned by a cleared queue)", async () => {
    existing(BACKGROUND_JOB_RUN_STATUS.queued);
    getJob.mockResolvedValue(undefined);

    const runId = await createAndQueueCatchUp("BSE", "2026-09-18", ["AAA", "BBB"], { force: true });

    expect(runId).toBe("run-1");
    expect(addJobWithTimeout).toHaveBeenCalledTimes(1);
    expect(addJobWithTimeout.mock.calls[0][3]).toMatchObject({ jobId: JOB_ID });
    expect(addJobWithTimeout.mock.calls[0][2]).toMatchObject({ exchange: "BSE", tradingDate: "2026-09-18", ledgerRunId: "run-1" });
    expect(state.updates).toContainEqual(expect.objectContaining({ status: BACKGROUND_JOB_RUN_STATUS.queued, bullmqJobId: JOB_ID }));
  });

  it("re-enqueues a running run whose BullMQ job is gone", async () => {
    existing(BACKGROUND_JOB_RUN_STATUS.running);
    getJob.mockResolvedValue(undefined);

    await createAndQueueCatchUp("BSE", "2026-09-18", ["AAA"], { force: true });

    expect(addJobWithTimeout).toHaveBeenCalledTimes(1);
  });

  it.each(["waiting", "active", "delayed"])("does not enqueue a duplicate while the job is %s", async (jobState) => {
    existing(BACKGROUND_JOB_RUN_STATUS.queued);
    getJob.mockResolvedValue(liveJob(jobState));

    const runId = await createAndQueueCatchUp("BSE", "2026-09-18", ["AAA"], { force: true });

    expect(runId).toBe("run-1");
    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });

  it("does not touch a completed run", async () => {
    existing(BACKGROUND_JOB_RUN_STATUS.completed);

    await createAndQueueCatchUp("BSE", "2026-09-18", ["AAA"], { force: true });

    expect(getJob).not.toHaveBeenCalled();
    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });

  it.each([BACKGROUND_JOB_RUN_STATUS.failed, BACKGROUND_JOB_RUN_STATUS.partial, BACKGROUND_JOB_RUN_STATUS.missed])(
    "still re-enqueues a %s run as before",
    async (status) => {
      existing(status);

      await createAndQueueCatchUp("BSE", "2026-09-18", ["AAA"], { force: true });

      expect(addJobWithTimeout).toHaveBeenCalledTimes(1);
    },
  );

  it("does nothing when there are no symbols to fetch", async () => {
    existing(BACKGROUND_JOB_RUN_STATUS.queued);

    await expect(createAndQueueCatchUp("BSE", "2026-09-18", [], { force: true })).resolves.toBeNull();
    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });
});
