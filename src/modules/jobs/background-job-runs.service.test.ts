import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { insert: vi.fn(), update: vi.fn(), select: vi.fn() } }));
vi.mock("./realtime-events", () => ({ publishRealtimeEvent: vi.fn() }));
vi.mock("../market-data/trading-calendar", () => ({ getLatestExpectedTradingDay: vi.fn(() => "2026-09-16") }));

import * as dbClientModule from "../../db/client";
import * as realtimeEventsModule from "./realtime-events";
import { BACKGROUND_JOB_TYPES } from "../../shared/constants";
import type { DailyCandleSyncSummary } from "../market-data/market-data.candle-sync";
import {
  emitJobProgress,
  failBackgroundJobRun,
  finishBackgroundJobRunFromSummary,
  recordChartEnsureFreshResultIfNeeded,
  recordChartEnsureFreshRun,
  startBackgroundJobRun,
} from "./background-job-runs.service";

const db = vi.mocked(dbClientModule.db);
const publishRealtimeEvent = vi.mocked(realtimeEventsModule.publishRealtimeEvent);

function baseSummary(overrides: Partial<DailyCandleSyncSummary> = {}): DailyCandleSyncSummary {
  return {
    processed: 0,
    updated: 0,
    repaired: 0,
    alreadyCurrent: 0,
    bootstrapRequired: 0,
    providerEmpty: 0,
    providerEmptySymbols: [],
    failed: 0,
    failedSymbols: [],
    failedDetails: [],
    ...overrides,
  };
}

function mockInsertChain(returned: unknown) {
  const returning = vi.fn(async () => [returned]);
  const values = vi.fn((_values: Record<string, unknown>) => ({ returning }));
  db.insert.mockReturnValueOnce({ values } as never);
  return values;
}

function mockUpdateChain() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  db.update.mockReturnValueOnce({ set } as never);
  return set;
}

describe("startBackgroundJobRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a row with status running and returns its id", async () => {
    const values = mockInsertChain({ id: "run-1" });

    const id = await startBackgroundJobRun(BACKGROUND_JOB_TYPES.dailyCandleMorning);

    expect(id).toBe("run-1");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: BACKGROUND_JOB_TYPES.dailyCandleMorning, status: "running" })
    );
  });

  it("publishes a job-started admin event", async () => {
    mockInsertChain({ id: "run-1" });

    await startBackgroundJobRun(BACKGROUND_JOB_TYPES.dailyCandleMorning);

    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin",
        event: expect.objectContaining({
          type: "market-data:job-started",
          data: expect.objectContaining({ runId: "run-1", jobType: BACKGROUND_JOB_TYPES.dailyCandleMorning }),
        }),
      })
    );
  });
});

describe("finishBackgroundJobRunFromSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a zero-failure run completed and publishes job-completed AFTER the DB write", async () => {
    const set = mockUpdateChain();
    const callOrder: string[] = [];
    set.mockImplementationOnce(() => {
      callOrder.push("db-write");
      return { where: vi.fn(async () => undefined) };
    });
    publishRealtimeEvent.mockImplementationOnce(async () => {
      callOrder.push("publish");
    });

    await finishBackgroundJobRunFromSummary(
      "run-1",
      BACKGROUND_JOB_TYPES.dailyCandleMorning,
      baseSummary({ processed: 5, updated: 5 })
    );

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", failedCount: 0 }));
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin",
        event: expect.objectContaining({ type: "market-data:job-completed" }),
      })
    );
    expect(callOrder).toEqual(["db-write", "publish"]);
  });

  it("marks a mixed-result run partial and stores the failed count/symbols", async () => {
    const set = mockUpdateChain();
    const summary = baseSummary({
      processed: 3,
      updated: 2,
      failed: 1,
      failedSymbols: ["BAD"],
      failedDetails: [{ instrumentId: "i1", symbol: "BAD", reason: "provider error" }],
    });

    await finishBackgroundJobRunFromSummary("run-1", BACKGROUND_JOB_TYPES.dailyCandleMorning, summary);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "partial",
        failedCount: 1,
        metadata: {
          failedSymbols: [{ instrumentId: "i1", symbol: "BAD", reason: "provider error" }],
          coverageExemptSymbols: [],
        },
      })
    );
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: "market-data:job-completed", data: expect.objectContaining({ status: "partial" }) }),
      })
    );
  });
});

describe("failBackgroundJobRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the run failed with the given error message and publishes job-failed", async () => {
    const set = mockUpdateChain();

    await failBackgroundJobRun("run-1", BACKGROUND_JOB_TYPES.dailyCandleRetry, "database connection lost");

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorSummary: "database connection lost" })
    );
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin",
        event: expect.objectContaining({ type: "market-data:job-failed" }),
      })
    );
  });
});

describe("emitJobProgress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes a job-progress admin event without writing to the DB", async () => {
    await emitJobProgress({
      runId: "run-1",
      jobType: BACKGROUND_JOB_TYPES.dailyCandleMorning,
      processed: 25,
      total: 100,
      updated: 20,
      repaired: 3,
      failed: 2,
    });

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin",
        event: expect.objectContaining({ type: "market-data:job-progress", data: expect.objectContaining({ processed: 25 }) }),
      })
    );
  });
});

describe("recordChartEnsureFreshRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a completed run for an updated repair", async () => {
    const values = mockInsertChain({ id: "run-2" });

    await recordChartEnsureFreshRun({ status: "updated", symbol: "TCS", exchange: "BSE", instrumentId: "i1" });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: BACKGROUND_JOB_TYPES.chartEnsureFresh,
        status: "completed",
        updatedCount: 1,
      })
    );
  });

  it("records a failed run with a failedSymbols entry", async () => {
    const values = mockInsertChain({ id: "run-3" });

    await recordChartEnsureFreshRun({
      status: "failed",
      symbol: "TCS",
      exchange: "BSE",
      instrumentId: "i1",
      failedDates: ["2026-09-10"],
    });

    expect(values).toHaveBeenCalledTimes(1);
    const insertedValues = values.mock.calls[0][0] as { metadata: { failedSymbols: unknown[] } };
    expect(insertedValues.metadata.failedSymbols).toHaveLength(1);
  });
});

describe("recordChartEnsureFreshResultIfNeeded", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not persist a row for a cache-hit already-current result", async () => {
    await recordChartEnsureFreshResultIfNeeded(
      { status: "already-current", instrumentId: "i1", failedDates: [] },
      "TCS",
      "BSE"
    );

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not persist a row for bootstrap-required or provider-empty results", async () => {
    await recordChartEnsureFreshResultIfNeeded(
      { status: "bootstrap-required", instrumentId: "i1", failedDates: [] },
      "TCS",
      "BSE"
    );
    await recordChartEnsureFreshResultIfNeeded(
      { status: "provider-empty", instrumentId: "i1", failedDates: [] },
      "TCS",
      "BSE"
    );

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("persists a row and publishes symbol-refreshed when an actual repair was executed", async () => {
    mockInsertChain({ id: "run-4" });

    await recordChartEnsureFreshResultIfNeeded(
      { status: "updated", instrumentId: "i1", failedDates: [] },
      "TCS",
      "BSE"
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "symbol",
        event: expect.objectContaining({ symbol: "TCS", exchange: "BSE", status: "updated" }),
      })
    );
  });

  it("persists a row but does NOT publish symbol-refreshed when the repair failed", async () => {
    mockInsertChain({ id: "run-5" });

    await recordChartEnsureFreshResultIfNeeded(
      { status: "failed", instrumentId: "i1", failedDates: ["2026-09-10"] },
      "TCS",
      "BSE"
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(publishRealtimeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "symbol" })
    );
  });

  it("does not publish symbol-refreshed for an already-current cache hit", async () => {
    await recordChartEnsureFreshResultIfNeeded(
      { status: "already-current", instrumentId: "i1", failedDates: [] },
      "TCS",
      "BSE"
    );

    expect(publishRealtimeEvent).not.toHaveBeenCalled();
  });
});
