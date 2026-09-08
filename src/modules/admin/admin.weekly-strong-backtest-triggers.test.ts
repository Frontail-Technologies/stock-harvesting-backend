import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { insert: vi.fn(), update: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("../jobs/queues", () => ({ getMarketDataQueue: vi.fn(), addJobWithTimeout: vi.fn() }));
vi.mock("../weekly-strong-backtest/weekly-strong-backtest.generation", () => ({
  runWeeklyStrongBacktestBackfill: vi.fn(),
  runWeeklyStrongBacktestHistoricalRebuild: vi.fn(),
}));
vi.mock("../../shared/env", () => ({ env: { NODE_ENV: "test" } }));

import * as dbClientModule from "../../db/client";
import * as queuesModule from "../jobs/queues";
import * as generationModule from "../weekly-strong-backtest/weekly-strong-backtest.generation";
import { env } from "../../shared/env";
import { triggerWeeklyStrongBacktestBackfill, triggerWeeklyStrongBacktestHistoricalRebuild } from "./admin.service";

const db = vi.mocked(dbClientModule.db);
const getMarketDataQueue = vi.mocked(queuesModule.getMarketDataQueue);
const addJobWithTimeout = vi.mocked(queuesModule.addJobWithTimeout);
const runWeeklyStrongBacktestBackfill = vi.mocked(generationModule.runWeeklyStrongBacktestBackfill);
const runWeeklyStrongBacktestHistoricalRebuild = vi.mocked(generationModule.runWeeklyStrongBacktestHistoricalRebuild);

function mockInsertChain(row: { id: string; status: string }) {
  db.insert.mockReturnValue({
    values: () => ({ returning: async () => [row] }),
  } as never);
}

function mockUpdateChain() {
  const set = vi.fn((_values: Record<string, unknown>) => ({ where: async () => undefined }));
  db.update.mockReturnValue({ set } as never);
  return set;
}

// Root cause regression (BSE 100 stuck "Generating" forever): the syncJobs row is inserted
// "queued" before the enqueue attempt - if that enqueue hangs/fails because Redis is configured
// but unreachable, the row must never stay "queued" forever. Outside production it falls back to
// running inline (development-only convenience) and ends up "completed"/"failed"; in production it
// must never run the heavy backfill inline - it goes straight to a "failed" terminal state with a
// safe error instead.
describe("triggerWeeklyStrongBacktestBackfill: enqueue failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });

  it("development: falls back to running inline and marks the job completed when the queue is configured but enqueue fails", async () => {
    mockInsertChain({ id: "job-1", status: "queued" });
    const set = mockUpdateChain();
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing job"));
    runWeeklyStrongBacktestBackfill.mockResolvedValue({
      collectionId: "col-1",
      weeksRequested: 10,
      weeksGenerated: 10,
      totalMembersPersisted: 50,
    } as never);

    const result = await triggerWeeklyStrongBacktestBackfill({ actorUserId: "admin-1", collectionId: "col-1" });

    expect(runWeeklyStrongBacktestBackfill).toHaveBeenCalledWith({ collectionId: "col-1", weeks: undefined });
    const statuses = set.mock.calls.map((call) => (call[0] as { status?: string }).status);
    expect(statuses).toEqual(["running", "completed"]);
    expect(result).toEqual({ syncJobId: "job-1", status: "queued" });
  });

  it("development: marks the job failed (not left queued) when the inline fallback itself throws", async () => {
    mockInsertChain({ id: "job-1", status: "queued" });
    const set = mockUpdateChain();
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing job"));
    runWeeklyStrongBacktestBackfill.mockRejectedValue(new Error("evaluator blew up"));

    await expect(
      triggerWeeklyStrongBacktestBackfill({ actorUserId: "admin-1", collectionId: "col-1" })
    ).rejects.toThrow("evaluator blew up");

    const statuses = set.mock.calls.map((call) => (call[0] as { status?: string }).status);
    expect(statuses).toEqual(["running", "failed"]);
  });

  it("production: never runs the backfill inline when enqueue fails - marks the job failed with a safe error instead", async () => {
    mockInsertChain({ id: "job-1", status: "queued" });
    const set = mockUpdateChain();
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing job"));
    (env as { NODE_ENV: string }).NODE_ENV = "production";

    const result = await triggerWeeklyStrongBacktestBackfill({ actorUserId: "admin-1", collectionId: "col-1" });

    expect(runWeeklyStrongBacktestBackfill).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: expect.stringContaining("unavailable") })
    );
    expect(result).toEqual({ syncJobId: "job-1", status: "failed" });
  });

  it("enqueues (with a deterministic per-collection jobId) without running inline when the queue is reachable", async () => {
    mockInsertChain({ id: "job-1", status: "queued" });
    mockUpdateChain();
    const queue = {} as never;
    getMarketDataQueue.mockReturnValue(queue);
    addJobWithTimeout.mockResolvedValue(undefined);

    await triggerWeeklyStrongBacktestBackfill({ actorUserId: "admin-1", collectionId: "col-1" });

    expect(addJobWithTimeout).toHaveBeenCalledWith(
      queue,
      "weekly-strong-backtest-backfill",
      expect.objectContaining({ collectionId: "col-1" }),
      { jobId: "weekly-strong-backtest-backfill:col-1" }
    );
    expect(runWeeklyStrongBacktestBackfill).not.toHaveBeenCalled();
  });
});

describe("triggerWeeklyStrongBacktestHistoricalRebuild: enqueue failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });

  it("development: falls back to running inline and marks the job completed when the queue is configured but enqueue fails", async () => {
    mockInsertChain({ id: "job-2", status: "queued" });
    const set = mockUpdateChain();
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing job"));
    runWeeklyStrongBacktestHistoricalRebuild.mockResolvedValue({
      collectionId: "col-1",
      weeksConsidered: 5,
      weeksGenerated: 5,
      totalMembersPersisted: 20,
      uncoveredWeeks: [],
      versionsUsed: 1,
    } as never);

    const result = await triggerWeeklyStrongBacktestHistoricalRebuild({
      actorUserId: "admin-1",
      collectionId: "col-1",
    });

    expect(runWeeklyStrongBacktestHistoricalRebuild).toHaveBeenCalledWith({ collectionId: "col-1" });
    const statuses = set.mock.calls.map((call) => (call[0] as { status?: string }).status);
    expect(statuses).toEqual(["running", "completed"]);
    expect(result).toEqual({ syncJobId: "job-2", status: "queued" });
  });

  it("production: never runs the rebuild inline when enqueue fails - marks the job failed with a safe error instead", async () => {
    mockInsertChain({ id: "job-2", status: "queued" });
    const set = mockUpdateChain();
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing job"));
    (env as { NODE_ENV: string }).NODE_ENV = "production";

    const result = await triggerWeeklyStrongBacktestHistoricalRebuild({
      actorUserId: "admin-1",
      collectionId: "col-1",
    });

    expect(runWeeklyStrongBacktestHistoricalRebuild).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: expect.stringContaining("unavailable") })
    );
    expect(result).toEqual({ syncJobId: "job-2", status: "failed" });
  });
});
