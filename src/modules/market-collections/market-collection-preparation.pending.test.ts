import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.hoisted(() => vi.fn());
const addJobWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: {
    select: () => ({
      from: () => ({ where: (condition: unknown) => whereMock(condition) }),
    }),
  },
}));
vi.mock("../jobs/queues", () => ({
  addJobWithTimeout,
  getMarketDataQueue: vi.fn(() => ({ fake: "queue" })),
}));
vi.mock("../market-data/market-data.candle-sync", () => ({ runChartBackfillOnce: vi.fn() }));
vi.mock("../market-data/market-data.candles", () => ({
  findSymbolsNeedingHistoryBackfill: vi.fn(),
  groupMetricCandlesBySymbol: vi.fn(),
}));
vi.mock("../market-data/market-data.metrics", () => ({
  readDailyAndWeeklyMetricCandles: vi.fn(),
  WEEKLY_STRONG_BACKTEST_FETCH_YEARS: 5,
}));
vi.mock("../weekly-strong-backtest/weekly-strong-backtest.generation", () => ({
  runWeeklyStrongBacktestBackfill: vi.fn(),
  runWeeklyStrongBacktestHistoricalRebuild: vi.fn(),
}));
vi.mock("./market-collections.service", () => ({ getActiveMemberInstrumentRows: vi.fn() }));

import { triggerPendingCollectionPreparations } from "./market-collection-preparation.service";

const dialect = new PgDialect();
const NOW = new Date("2026-09-19T16:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  addJobWithTimeout.mockResolvedValue(undefined);
});

describe("triggerPendingCollectionPreparations - segments stuck on 'Preparing'", () => {
  it("enqueues preparation for a pending segment that has no live job behind it, with its latest membership version", async () => {
    whereMock.mockResolvedValue([{ id: "seg-1", latestMembershipVersionId: "ver-9" }]);

    const count = await triggerPendingCollectionPreparations(NOW);

    expect(count).toBe(1);
    expect(addJobWithTimeout).toHaveBeenCalledTimes(1);
    expect(addJobWithTimeout).toHaveBeenCalledWith(
      expect.anything(),
      "collection-prepare",
      { collectionId: "seg-1", membershipVersionId: "ver-9" },
      { jobId: "collection-prepare:seg-1:ver-9" }
    );
  });

  it("uses a stable version-less job id for an auto-populated segment (no membership versions)", async () => {
    whereMock.mockResolvedValue([{ id: "auto-1", latestMembershipVersionId: null }]);

    await triggerPendingCollectionPreparations(NOW);

    expect(addJobWithTimeout).toHaveBeenCalledWith(
      expect.anything(),
      "collection-prepare",
      { collectionId: "auto-1", membershipVersionId: null },
      { jobId: "collection-prepare:auto-1:none" }
    );
  });

  it("does nothing when no segment is stuck pending", async () => {
    whereMock.mockResolvedValue([]);

    await expect(triggerPendingCollectionPreparations(NOW)).resolves.toBe(0);
    expect(addJobWithTimeout).not.toHaveBeenCalled();
  });

  it("only considers active, pending, non-empty segments that have been pending longer than the grace period", async () => {
    whereMock.mockResolvedValue([]);

    await triggerPendingCollectionPreparations(NOW);

    const condition = whereMock.mock.calls[0][0];
    const { sql, params } = dialect.sqlToQuery(condition);
    expect(sql).toMatch(/"active" = \$\d+/);
    expect(sql).toMatch(/"preparation_status" = \$\d+/);
    expect(sql).toMatch(/"updated_at" < \$\d+/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM market_collection_members/);
    expect(params).toContain("pending");
    const expectedCutoff = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(params.map((param) => (param instanceof Date ? param.toISOString() : param))).toContain(expectedCutoff);
  });

  it("re-running is idempotent: the deterministic job id lets the queue collapse a job that is already waiting or running", async () => {
    whereMock.mockResolvedValue([{ id: "seg-1", latestMembershipVersionId: null }]);

    await triggerPendingCollectionPreparations(NOW);
    await triggerPendingCollectionPreparations(NOW);

    const jobIds = addJobWithTimeout.mock.calls.map((call) => call[3].jobId);
    expect(new Set(jobIds).size).toBe(1);
  });
});
