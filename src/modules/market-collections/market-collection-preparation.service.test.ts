import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock("./market-collections.service", () => ({
  getActiveMemberInstrumentRows: vi.fn(),
}));
vi.mock("../market-data/market-data.candles", () => ({
  findSymbolsNeedingHistoryBackfill: vi.fn(),
  groupMetricCandlesBySymbol: vi.fn((rows: Array<{ symbol: string }>) => {
    const map = new Map<string, unknown[]>();
    for (const row of rows) {
      const list = map.get(row.symbol) ?? [];
      list.push(row);
      map.set(row.symbol, list);
    }
    return map;
  }),
}));
vi.mock("../market-data/market-data.candle-sync", () => ({ runChartBackfillOnce: vi.fn() }));
vi.mock("../market-data/market-data.metrics", () => ({
  readDailyAndWeeklyMetricCandles: vi.fn(),
  WEEKLY_STRONG_BACKTEST_FETCH_YEARS: 10,
}));
vi.mock("../market-data/weekly-strong-evaluator", () => ({ hasSufficientWeeklyStrongHistory: vi.fn() }));
vi.mock("../weekly-strong-backtest/weekly-strong-backtest.generation", () => ({
  runWeeklyStrongBacktestBackfill: vi.fn(),
  runWeeklyStrongBacktestHistoricalRebuild: vi.fn(),
}));
vi.mock("../jobs/queues", () => ({ getMarketDataQueue: vi.fn(), addJobWithTimeout: vi.fn() }));
vi.mock("../../shared/env", () => ({ env: { NODE_ENV: "test" } }));

import * as dbClientModule from "../../db/client";
import * as candlesModule from "../market-data/market-data.candles";
import * as candleSyncModule from "../market-data/market-data.candle-sync";
import * as metricsModule from "../market-data/market-data.metrics";
import * as evaluatorModule from "../market-data/weekly-strong-evaluator";
import * as generationModule from "../weekly-strong-backtest/weekly-strong-backtest.generation";
import * as queuesModule from "../jobs/queues";
import { env } from "../../shared/env";
import * as collectionsServiceModule from "./market-collections.service";
import { prepareCollectionData, triggerCollectionPreparation } from "./market-collection-preparation.service";

const db = vi.mocked(dbClientModule.db);
const getActiveMemberInstrumentRows = vi.mocked(collectionsServiceModule.getActiveMemberInstrumentRows);
const findSymbolsNeedingHistoryBackfill = vi.mocked(candlesModule.findSymbolsNeedingHistoryBackfill);
const runChartBackfillOnce = vi.mocked(candleSyncModule.runChartBackfillOnce);
const readDailyAndWeeklyMetricCandles = vi.mocked(metricsModule.readDailyAndWeeklyMetricCandles);
const hasSufficientWeeklyStrongHistory = vi.mocked(evaluatorModule.hasSufficientWeeklyStrongHistory);
const runWeeklyStrongBacktestBackfill = vi.mocked(generationModule.runWeeklyStrongBacktestBackfill);
const runWeeklyStrongBacktestHistoricalRebuild = vi.mocked(generationModule.runWeeklyStrongBacktestHistoricalRebuild);
const getMarketDataQueue = vi.mocked(queuesModule.getMarketDataQueue);
const addJobWithTimeout = vi.mocked(queuesModule.addJobWithTimeout);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

function mockUpdateChain() {
  const set = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn(async () => undefined) }));
  db.update.mockReturnValue({ set } as never);
  return set;
}

const MEMBERS = [
  { instrumentId: "i1", symbol: "AAA", name: "AAA Ltd", exchange: "BSE", sector: null, industry: null },
  { instrumentId: "i2", symbol: "BBB", name: "BBB Ltd", exchange: "BSE", sector: null, industry: null },
];

const EXISTING_COLLECTION_ROW = { id: "col-1", exchange: "BSE" };

describe("prepareCollectionData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveMemberInstrumentRows.mockResolvedValue(MEMBERS as never);
    findSymbolsNeedingHistoryBackfill.mockResolvedValue([]);
    runChartBackfillOnce.mockResolvedValue(undefined as never);
    runWeeklyStrongBacktestBackfill.mockResolvedValue({} as never);
    readDailyAndWeeklyMetricCandles.mockResolvedValue({ dailyCandles: [], weeklyCandles: [] } as never);
    hasSufficientWeeklyStrongHistory.mockReturnValue(true);
    // Three db.select calls happen per successful run: (1) the collection
    // still exists (default: yes), (2) does a current-membership backtest
    // already exist (default: no), (3) the final staleness check (default:
    // still current, matches "v1").
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockReturnValueOnce(selectResult([]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v1" }]) as never);
  });

  it("J: no-ops without touching members/backfill/backtest when the collection no longer exists", async () => {
    db.select.mockReset();
    db.select.mockReturnValueOnce(selectResult([]) as never);

    const result = await prepareCollectionData("col-1", "v1");

    expect(result).toEqual({
      collectionId: "col-1",
      skipped: true,
      totalMembers: 0,
      membersWithRequiredHistory: null,
      membersUnavailable: null,
    });
    expect(getActiveMemberInstrumentRows).not.toHaveBeenCalled();
    expect(runChartBackfillOnce).not.toHaveBeenCalled();
    expect(runWeeklyStrongBacktestBackfill).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("G: status transitions through syncing_candles -> building_backtest -> ready in order", async () => {
    const set = mockUpdateChain();

    await prepareCollectionData("col-1", "v1");

    const statuses = set.mock.calls.map((call) => (call[0] as { preparationStatus?: string }).preparationStatus);
    expect(statuses).toEqual(["syncing_candles", "building_backtest", "ready"]);
  });

  it("C/D: only symbols findSymbolsNeedingHistoryBackfill returns are backfilled", async () => {
    findSymbolsNeedingHistoryBackfill.mockResolvedValue(["BBB"]);
    mockUpdateChain();

    await prepareCollectionData("col-1", "v1");

    expect(runChartBackfillOnce).toHaveBeenCalledTimes(1);
    expect(runChartBackfillOnce).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BBB", exchange: "BSE" })
    );
  });

  it("H: a successful candle step is followed by a call into runWeeklyStrongBacktestBackfill", async () => {
    mockUpdateChain();

    await prepareCollectionData("col-1", "v1");

    expect(runWeeklyStrongBacktestBackfill).toHaveBeenCalledWith({ collectionId: "col-1" });
  });

  it("F: an instrument backfill failure does not throw - preparation still resolves", async () => {
    findSymbolsNeedingHistoryBackfill.mockResolvedValue(["AAA"]);
    runChartBackfillOnce.mockRejectedValue(new Error("provider down"));
    mockUpdateChain();

    const result = await prepareCollectionData("col-1", "v1");

    expect(result.skipped).toBe(false);
  });

  it("D (correction): a recently-listed member with limited but sufficient available history is not marked unavailable", async () => {
    hasSufficientWeeklyStrongHistory.mockReturnValue(true);
    readDailyAndWeeklyMetricCandles.mockResolvedValue({
      dailyCandles: [{ symbol: "AAA" }, { symbol: "BBB" }],
      weeklyCandles: [{ symbol: "AAA" }, { symbol: "BBB" }],
    } as never);
    mockUpdateChain();

    const result = await prepareCollectionData("col-1", "v1");

    expect(result.membersUnavailable).toBe(0);
    expect(result.membersWithRequiredHistory).toBe(2);
  });

  it("marks partial when at least one member lacks sufficient history", async () => {
    hasSufficientWeeklyStrongHistory.mockImplementation((daily: number) => daily > 0);
    readDailyAndWeeklyMetricCandles.mockResolvedValue({
      dailyCandles: [{ symbol: "AAA" }],
      weeklyCandles: [{ symbol: "AAA" }],
    } as never);
    const set = mockUpdateChain();

    await prepareCollectionData("col-1", "v1");

    const finalCall = set.mock.calls.find(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus === "partial"
    );
    expect(finalCall).toBeDefined();
  });

  it("K: an existing current-membership backtest triggers historical rebuild too", async () => {
    db.select.mockReset();
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockReturnValueOnce(selectResult([{ id: "existing-run" }]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v1" }]) as never);
    mockUpdateChain();

    await prepareCollectionData("col-1", "v1");

    expect(runWeeklyStrongBacktestHistoricalRebuild).toHaveBeenCalledWith({ collectionId: "col-1" });
  });

  it("B: a stale membership version at completion skips the final ready/partial write", async () => {
    const set = mockUpdateChain();
    db.select.mockReset();
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockReturnValueOnce(selectResult([]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v2" }]) as never);

    const result = await prepareCollectionData("col-1", "v1");

    expect(result.skipped).toBe(true);
    const finalStatuses = set.mock.calls.map(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus
    );
    expect(finalStatuses).not.toContain("ready");
    expect(finalStatuses).not.toContain("partial");
  });

  it("C: a still-current membership version at completion writes normally", async () => {
    const set = mockUpdateChain();

    const result = await prepareCollectionData("col-1", "v1");

    expect(result.skipped).toBe(false);
    const finalStatuses = set.mock.calls.map(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus
    );
    expect(finalStatuses).toContain("ready");
  });

  it("I: a hard failure mid-run leaves preparationStatus failed with a populated error", async () => {
    const set = mockUpdateChain();
    // The failure happens before hasExistingCurrentMembershipBacktest's own
    // select call is ever reached - only the existence check and the catch
    // block's staleness check occur, both matching "v1" here.
    db.select.mockReset();
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v1" }]) as never);
    runWeeklyStrongBacktestBackfill.mockRejectedValue(new Error("db exploded"));

    const result = await prepareCollectionData("col-1", "v1");

    expect(result.skipped).toBe(false);
    const failedCall = set.mock.calls.find(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus === "failed"
    );
    expect(failedCall).toBeDefined();
    expect((failedCall?.[0] as { preparationError?: string }).preparationError).toContain("db exploded");
  });

  it("coverage-detection failure fails closed: status failed, no backfill or backtest started", async () => {
    const set = mockUpdateChain();
    db.select.mockReset();
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v1" }]) as never);
    findSymbolsNeedingHistoryBackfill.mockRejectedValue(
      new Error("canceling statement due to statement timeout")
    );

    const result = await prepareCollectionData("col-1", "v1");

    expect(result.skipped).toBe(false);
    expect(runChartBackfillOnce).not.toHaveBeenCalled();
    expect(runWeeklyStrongBacktestBackfill).not.toHaveBeenCalled();
    const failedCall = set.mock.calls.find(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus === "failed"
    );
    expect(failedCall).toBeDefined();
    const persisted = (failedCall?.[0] as { preparationError?: string }).preparationError ?? "";
    expect(persisted).toMatch(/^coverage_detection: /);
  });

  it("persists a compact, stage-tagged error with the DB code and no SQL text", async () => {
    const set = mockUpdateChain();
    db.select.mockReset();
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v1" }]) as never);
    // Shape of a Drizzle error: the whole SQL is prefixed onto .message, the
    // real cause (pg DatabaseError) is on .cause.
    const drizzleError = Object.assign(
      new Error(
        'select "symbol", "time", "open", "high", "low", "close", "volume" from "candles" where ...'
      ),
      {
        cause: { code: "57014", message: "canceling statement due to statement timeout" },
      }
    );
    runWeeklyStrongBacktestBackfill.mockRejectedValue(drizzleError);

    await prepareCollectionData("col-1", "v1");

    const failedCall = set.mock.calls.find(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus === "failed"
    );
    const persisted = (failedCall?.[0] as { preparationError?: string }).preparationError ?? "";
    expect(persisted).toBe(
      "current_membership_backtest: [57014] canceling statement due to statement timeout"
    );
    expect(persisted).not.toMatch(/select |from "candles"/i);
    expect(persisted.length).toBeLessThanOrEqual(280);
  });

  it("falls back to 'database query failed' when only a SQL-prefixed message is available", async () => {
    const set = mockUpdateChain();
    db.select.mockReset();
    db.select
      .mockReturnValueOnce(selectResult([EXISTING_COLLECTION_ROW]) as never)
      .mockImplementation(() => selectResult([{ latestMembershipVersionId: "v1" }]) as never);
    runWeeklyStrongBacktestBackfill.mockRejectedValue(
      new Error('select "symbol" from "candles" where "x" = $1\nparams: BSE')
    );

    await prepareCollectionData("col-1", "v1");

    const failedCall = set.mock.calls.find(
      (call) => (call[0] as { preparationStatus?: string }).preparationStatus === "failed"
    );
    const persisted = (failedCall?.[0] as { preparationError?: string }).preparationError ?? "";
    expect(persisted).toBe("current_membership_backtest: database query failed");
  });
});

describe("triggerCollectionPreparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveMemberInstrumentRows.mockResolvedValue([] as never);
    db.select.mockReturnValue(selectResult([EXISTING_COLLECTION_ROW]) as never);
    mockUpdateChain();
  });

  it("enqueues via the market-data queue when one is available, with a deterministic jobId", async () => {
    const queue = {} as never;
    getMarketDataQueue.mockReturnValue(queue);
    addJobWithTimeout.mockResolvedValue(undefined);

    await triggerCollectionPreparation("col-1", "v1");

    expect(addJobWithTimeout).toHaveBeenCalledWith(
      queue,
      "collection-prepare",
      { collectionId: "col-1", membershipVersionId: "v1" },
      { jobId: "collection-prepare:col-1:v1" }
    );
    expect(getActiveMemberInstrumentRows).not.toHaveBeenCalled();
  });

  it("F: with no queue and NODE_ENV=production, never runs preparation inline", async () => {
    getMarketDataQueue.mockReturnValue(null);
    (env as { NODE_ENV: string }).NODE_ENV = "production";

    await triggerCollectionPreparation("col-1", "v1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(db.select).not.toHaveBeenCalled();
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });

  it("with no queue and NODE_ENV!=production, falls back to an in-process run", async () => {
    getMarketDataQueue.mockReturnValue(null);

    await triggerCollectionPreparation("col-1", "v1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getActiveMemberInstrumentRows).toHaveBeenCalledWith("col-1");
  });

  it("root cause regression: a queue that is configured but unreachable (enqueue fails) falls back to an in-process run outside production, instead of leaving the collection stuck pending forever", async () => {
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing collection-prepare job"));

    await triggerCollectionPreparation("col-1", "v1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getActiveMemberInstrumentRows).toHaveBeenCalledWith("col-1");
  });

  it("follow-up correctness fix: a queue that is configured but unreachable in production is marked failed with a safe error, never run inline", async () => {
    getMarketDataQueue.mockReturnValue({} as never);
    addJobWithTimeout.mockRejectedValue(new Error("Timed out enqueueing collection-prepare job"));
    const set = mockUpdateChain();
    (env as { NODE_ENV: string }).NODE_ENV = "production";

    await triggerCollectionPreparation("col-1", "v1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getActiveMemberInstrumentRows).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        preparationStatus: "failed",
        preparationError: expect.stringContaining("unavailable"),
      })
    );
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });
});
