import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../modules/market-data/market-data.candle-sync", () => ({ backfillDailyCandles: vi.fn() }));
vi.mock("../modules/market-data/market-data.candle-bootstrap-checkpoints", () => ({
  readCandleBootstrapCheckpointsInBatches: vi.fn(),
  upsertCandleBootstrapCheckpoint: vi.fn(),
  isCandleBootstrapCheckpointSatisfied: vi.fn(),
}));

import * as candleSyncModule from "../modules/market-data/market-data.candle-sync";
import * as checkpointsModule from "../modules/market-data/market-data.candle-bootstrap-checkpoints";
import {
  BOOTSTRAP_KIND,
  BOOTSTRAP_VERSION,
  DEFAULT_CONCURRENCY,
  isBseEquitySegment,
  MAX_CONCURRENCY,
  parseArgs,
  processQueue,
  recordBootstrapCheckpoints,
  resolveBootstrapQueue,
  resolveConcurrency,
  resolveDate,
  resolveLimit,
  runWithConcurrency,
  summarize,
  type InstrumentResult,
  type QueueItem,
} from "./bootstrap-bse-candles";

const backfillDailyCandles = vi.mocked(candleSyncModule.backfillDailyCandles);
const readCandleBootstrapCheckpointsInBatches = vi.mocked(checkpointsModule.readCandleBootstrapCheckpointsInBatches);
const upsertCandleBootstrapCheckpoint = vi.mocked(checkpointsModule.upsertCandleBootstrapCheckpoint);
const isCandleBootstrapCheckpointSatisfied = vi.mocked(checkpointsModule.isCandleBootstrapCheckpointSatisfied);

describe("isBseEquitySegment", () => {
  it("includes a normal Group A/B equity segment", () => {
    expect(isBseEquitySegment("A")).toBe(true);
    expect(isBseEquitySegment("B")).toBe(true);
  });

  it("includes SME segments", () => {
    expect(isBseEquitySegment("M")).toBe(true);
    expect(isBseEquitySegment("MT")).toBe(true);
    expect(isBseEquitySegment("MS")).toBe(true);
  });

  it("includes T/TS/Z/ZP/X/XT/NS/NT/P equity sub-segments", () => {
    for (const segment of ["T", "TS", "Z", "ZP", "X", "XT", "NS", "NT", "P"]) {
      expect(isBseEquitySegment(segment)).toBe(true);
    }
  });

  it("excludes the debt/fixed-income segment", () => {
    expect(isBseEquitySegment("F")).toBe(false);
  });

  it("excludes InvIT/REIT trust units", () => {
    expect(isBseEquitySegment("IF")).toBe(false);
  });

  it("excludes rights entitlements", () => {
    expect(isBseEquitySegment("R")).toBe(false);
  });

  it("excludes an unclassified (null) segment rather than assuming it's equity", () => {
    expect(isBseEquitySegment(null)).toBe(false);
  });
});

describe("resolveBootstrapQueue", () => {
  beforeEach(() => vi.clearAllMocks());

  const baseInput = {
    exchange: "BSE",
    requiredFromDate: "1996-09-09",
    bootstrapVersion: BOOTSTRAP_VERSION,
    kind: BOOTSTRAP_KIND,
  };

  it("--force marks every symbol as needing backfill without reading checkpoints at all", async () => {
    const queue = await resolveBootstrapQueue({
      ...baseInput,
      symbols: ["TCS", "NEWLISTCO"],
      force: true,
    });

    expect(queue).toEqual([
      { symbol: "TCS", needsBackfill: true },
      { symbol: "NEWLISTCO", needsBackfill: true },
    ]);
    expect(readCandleBootstrapCheckpointsInBatches).not.toHaveBeenCalled();
  });

  it("a symbol whose checkpoint is satisfied is not queued for backfill (skipped on resume)", async () => {
    const checkpoint = { symbol: "TCS", status: "success" as const, bootstrapVersion: 1, requestedFrom: "1996-09-09" };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["TCS", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(true);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["TCS"], force: false });

    expect(queue).toEqual([{ symbol: "TCS", needsBackfill: false }]);
  });

  it("a newly-listed instrument whose successful checkpoint's requestedFrom equals what's requested now is skipped, even though its first candle is decades after 1996", async () => {
    // The checkpoint records the *requested* from-date, not the instrument's actual earliest
    // candle - so a company that listed in 2015 and was fully bootstrapped is correctly
    // recognized as complete, instead of being reprocessed forever (the bug being fixed).
    const checkpoint = {
      symbol: "NEWLISTCO",
      status: "success" as const,
      bootstrapVersion: BOOTSTRAP_VERSION,
      requestedFrom: "1996-09-09",
    };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["NEWLISTCO", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(true);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["NEWLISTCO"], force: false });

    expect(queue).toEqual([{ symbol: "NEWLISTCO", needsBackfill: false }]);
  });

  it("a symbol with a failed checkpoint is queued for backfill (retried)", async () => {
    const checkpoint = { symbol: "BAD", status: "failed" as const, bootstrapVersion: 1, requestedFrom: "1996-09-09" };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["BAD", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(false);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["BAD"], force: false });

    expect(queue).toEqual([{ symbol: "BAD", needsBackfill: true }]);
  });

  it("a symbol with a partial checkpoint is queued for backfill (retried)", async () => {
    const checkpoint = { symbol: "PARTIAL", status: "partial" as const, bootstrapVersion: 1, requestedFrom: "1996-09-09" };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["PARTIAL", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(false);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["PARTIAL"], force: false });

    expect(queue).toEqual([{ symbol: "PARTIAL", needsBackfill: true }]);
  });

  it("a symbol with no checkpoint at all is queued for backfill", async () => {
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map());
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(false);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["NOCHECKPOINT"], force: false });

    expect(queue).toEqual([{ symbol: "NOCHECKPOINT", needsBackfill: true }]);
  });

  it("a materially earlier requested range invalidates an otherwise-successful checkpoint (delegated to isCandleBootstrapCheckpointSatisfied, verified via its own call args)", async () => {
    const checkpoint = { symbol: "TCS", status: "success" as const, bootstrapVersion: 1, requestedFrom: "2010-01-01" };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["TCS", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(false);

    await resolveBootstrapQueue({ ...baseInput, symbols: ["TCS"], requiredFromDate: "1996-09-09", force: false });

    expect(isCandleBootstrapCheckpointSatisfied).toHaveBeenCalledWith(checkpoint, {
      bootstrapVersion: BOOTSTRAP_VERSION,
      requestedFrom: "1996-09-09",
    });
  });

  it("a bootstrap version bump invalidates an old checkpoint (delegated the same way)", async () => {
    const checkpoint = { symbol: "TCS", status: "success" as const, bootstrapVersion: 1, requestedFrom: "1996-09-09" };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["TCS", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(false);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["TCS"], bootstrapVersion: 2, force: false });

    expect(queue).toEqual([{ symbol: "TCS", needsBackfill: true }]);
  });

  it("a checkpoint lookup failure propagates rather than being swallowed as all-covered or all-missing", async () => {
    readCandleBootstrapCheckpointsInBatches.mockRejectedValue(new Error("Query read timeout"));

    await expect(resolveBootstrapQueue({ ...baseInput, symbols: ["TCS"], force: false })).rejects.toThrow(
      "Query read timeout"
    );
  });

  it("zero-candle (partial) provider responses are not treated as complete", async () => {
    // Modeled via isCandleBootstrapCheckpointSatisfied returning false for a "partial" checkpoint -
    // recordBootstrapCheckpoints' own tests cover that a zero-candle outcome is written as "partial".
    const checkpoint = { symbol: "ZERO", status: "partial" as const, bootstrapVersion: 1, requestedFrom: "1996-09-09" };
    readCandleBootstrapCheckpointsInBatches.mockResolvedValue(new Map([["ZERO", checkpoint]]));
    isCandleBootstrapCheckpointSatisfied.mockReturnValue(false);

    const queue = await resolveBootstrapQueue({ ...baseInput, symbols: ["ZERO"], force: false });

    expect(queue).toEqual([{ symbol: "ZERO", needsBackfill: true }]);
  });
});

describe("recordBootstrapCheckpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  const context = {
    exchange: "BSE",
    kind: BOOTSTRAP_KIND,
    bootstrapVersion: BOOTSTRAP_VERSION,
    requestedFrom: "1996-09-09",
    requestedTo: "2026-09-09",
  };

  it("writes a success checkpoint for a successful result", async () => {
    upsertCandleBootstrapCheckpoint.mockResolvedValue(undefined);
    const results: InstrumentResult[] = [{ symbol: "TCS", outcome: "success", candles: 5000, durationMs: 10 }];

    await recordBootstrapCheckpoints(results, context);

    expect(upsertCandleBootstrapCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "TCS", status: "success", candleCount: 5000 })
    );
  });

  it("writes a partial checkpoint for a zero-candle result, not success", async () => {
    upsertCandleBootstrapCheckpoint.mockResolvedValue(undefined);
    const results: InstrumentResult[] = [{ symbol: "ZERO", outcome: "partial", candles: 0, durationMs: 5 }];

    await recordBootstrapCheckpoints(results, context);

    expect(upsertCandleBootstrapCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ZERO", status: "partial" })
    );
  });

  it("writes a failed checkpoint with the error message for a failed result", async () => {
    upsertCandleBootstrapCheckpoint.mockResolvedValue(undefined);
    const results: InstrumentResult[] = [
      { symbol: "BAD", outcome: "failed", candles: 0, durationMs: 5, error: "provider timeout" },
    ];

    await recordBootstrapCheckpoints(results, context);

    expect(upsertCandleBootstrapCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BAD", status: "failed", lastError: "provider timeout" })
    );
  });

  it("never writes a checkpoint for a skipped result - an existing satisfied checkpoint is left untouched", async () => {
    const results: InstrumentResult[] = [{ symbol: "ALREADYDONE", outcome: "skipped", candles: 0, durationMs: 0 }];

    await recordBootstrapCheckpoints(results, context);

    expect(upsertCandleBootstrapCheckpoint).not.toHaveBeenCalled();
  });

  it("one checkpoint write failure does not throw and does not block the rest", async () => {
    upsertCandleBootstrapCheckpoint
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(undefined);
    const results: InstrumentResult[] = [
      { symbol: "FAILSTOWRITE", outcome: "success", candles: 10, durationMs: 5 },
      { symbol: "OK", outcome: "success", candles: 10, durationMs: 5 },
    ];

    await expect(recordBootstrapCheckpoints(results, context)).resolves.toBeUndefined();
    expect(upsertCandleBootstrapCheckpoint).toHaveBeenCalledTimes(2);
  });
});

describe("parseArgs", () => {
  it("parses --key=value pairs and boolean flags", () => {
    const args = parseArgs(["--from=2020-01-01", "--force", "--concurrency=6"]);
    expect(args).toEqual({ from: "2020-01-01", force: true, concurrency: "6" });
  });

  it("ignores non-flag arguments", () => {
    expect(parseArgs(["node", "script.ts", "--force"])).toEqual({ force: true });
  });
});

describe("resolveDate", () => {
  it("returns the fallback when no value is given", () => {
    expect(resolveDate(undefined, "2020-01-01", "from")).toBe("2020-01-01");
  });

  it("returns a valid YYYY-MM-DD value as-is", () => {
    expect(resolveDate("2024-06-15", "2020-01-01", "from")).toBe("2024-06-15");
  });

  it("throws on a malformed date", () => {
    expect(() => resolveDate("15-06-2024", "2020-01-01", "from")).toThrow(/--from must use YYYY-MM-DD/);
  });
});

describe("resolveConcurrency", () => {
  it("defaults when no value is given", () => {
    expect(resolveConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
  });

  it("clamps a value above the max", () => {
    expect(resolveConcurrency(String(MAX_CONCURRENCY + 50))).toBe(MAX_CONCURRENCY);
  });

  it("falls back to the default for an invalid value", () => {
    expect(resolveConcurrency("not-a-number")).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency("0")).toBe(DEFAULT_CONCURRENCY);
  });
});

describe("resolveLimit", () => {
  it("returns undefined when no value is given", () => {
    expect(resolveLimit(undefined)).toBeUndefined();
  });

  it("parses a positive integer", () => {
    expect(resolveLimit("100")).toBe(100);
  });

  it("returns undefined for zero or a non-numeric value", () => {
    expect(resolveLimit("0")).toBeUndefined();
    expect(resolveLimit("abc")).toBeUndefined();
  });
});

describe("runWithConcurrency", () => {
  it("never runs more than the given concurrency at once", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency(items, 3, () => false, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("stops picking up new items once shouldStop returns true", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let processed = 0;

    await runWithConcurrency(items, 2, () => processed >= 5, async () => {
      processed++;
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    expect(processed).toBeLessThan(20);
  });
});

describe("processQueue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips an already-covered instrument without calling backfillDailyCandles", async () => {
    const queue: QueueItem[] = [{ symbol: "AAA", needsBackfill: false }];

    const results = await processQueue(queue, {
      from: "2020-01-01",
      to: "2024-01-01",
      concurrency: 2,
      shouldStop: () => false,
    });

    expect(results).toEqual([{ symbol: "AAA", outcome: "skipped", candles: 0, durationMs: 0 }]);
    expect(backfillDailyCandles).not.toHaveBeenCalled();
  });

  it("one instrument's failure does not abort the rest of the batch", async () => {
    const queue: QueueItem[] = [
      { symbol: "GOOD1", needsBackfill: true },
      { symbol: "BAD", needsBackfill: true },
      { symbol: "GOOD2", needsBackfill: true },
    ];
    backfillDailyCandles.mockImplementation(async ({ symbol }) => {
      if (symbol === "BAD") throw new Error("provider timeout");
      return { insertedDaily: 10, insertedWeekly: 2, insertedMonthly: 1 };
    });

    const results = await processQueue(queue, {
      from: "2020-01-01",
      to: "2024-01-01",
      concurrency: 3,
      shouldStop: () => false,
    });

    expect(results).toHaveLength(3);
    const summary = summarize(results);
    expect(summary.success).toBe(2);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].symbol).toBe("BAD");
    expect(summary.failed[0].error).toBe("provider timeout");
  });

  it("classifies a resolved zero-candle result as partial, not success", async () => {
    backfillDailyCandles.mockResolvedValue({ insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 });

    const results = await processQueue([{ symbol: "NODATA", needsBackfill: true }], {
      from: "2020-01-01",
      to: "2024-01-01",
      concurrency: 1,
      shouldStop: () => false,
    });

    expect(results[0].outcome).toBe("partial");
  });

  it("summarize reports accurate counters and total candles", async () => {
    const queue: QueueItem[] = [
      { symbol: "SKIP1", needsBackfill: false },
      { symbol: "OK1", needsBackfill: true },
      { symbol: "OK2", needsBackfill: true },
      { symbol: "FAIL1", needsBackfill: true },
    ];
    backfillDailyCandles.mockImplementation(async ({ symbol }) => {
      if (symbol === "FAIL1") throw new Error("network error");
      return { insertedDaily: 100, insertedWeekly: 20, insertedMonthly: 5 };
    });

    const results = await processQueue(queue, {
      from: "2020-01-01",
      to: "2024-01-01",
      concurrency: 2,
      shouldStop: () => false,
    });
    const summary = summarize(results);

    expect(summary.total).toBe(4);
    expect(summary.success).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.partial).toBe(0);
    expect(summary.failed).toHaveLength(1);
    expect(summary.candles).toBe(200);
  });

  it("stops processing further instruments once shouldStop reports true", async () => {
    const queue: QueueItem[] = Array.from({ length: 10 }, (_, i) => ({
      symbol: `SYM${i}`,
      needsBackfill: true,
    }));
    backfillDailyCandles.mockResolvedValue({ insertedDaily: 1, insertedWeekly: 0, insertedMonthly: 0 });

    let completedCount = 0;
    const results = await processQueue(queue, {
      from: "2020-01-01",
      to: "2024-01-01",
      concurrency: 2,
      shouldStop: () => completedCount >= 3,
      onProgress: (completed) => {
        completedCount = completed;
      },
    });

    expect(results.length).toBeLessThan(queue.length);
  });
});
