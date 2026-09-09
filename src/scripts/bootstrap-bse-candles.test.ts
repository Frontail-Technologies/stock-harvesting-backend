import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../modules/market-data/market-data.candle-sync", () => ({ backfillDailyCandles: vi.fn() }));
vi.mock("../modules/market-data/market-data.candles", () => ({ findSymbolsNeedingHistoryBackfill: vi.fn() }));

import * as candleSyncModule from "../modules/market-data/market-data.candle-sync";
import * as candlesModule from "../modules/market-data/market-data.candles";
import {
  COVERAGE_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  findMissingSymbolsInBatches,
  isBseEquitySegment,
  MAX_CONCURRENCY,
  parseArgs,
  processQueue,
  resolveConcurrency,
  resolveDate,
  resolveLimit,
  runWithConcurrency,
  summarize,
  type QueueItem,
} from "./bootstrap-bse-candles";

const backfillDailyCandles = vi.mocked(candleSyncModule.backfillDailyCandles);
const findSymbolsNeedingHistoryBackfill = vi.mocked(candlesModule.findSymbolsNeedingHistoryBackfill);

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

describe("findMissingSymbolsInBatches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty result for an empty symbol list without querying", async () => {
    const result = await findMissingSymbolsInBatches({ exchange: "BSE", symbols: [], requiredFromDate: "2015-01-01" });
    expect(result).toEqual([]);
    expect(findSymbolsNeedingHistoryBackfill).not.toHaveBeenCalled();
  });

  it("issues a single batch query for a symbol list at or under the batch size", async () => {
    const symbols = Array.from({ length: COVERAGE_BATCH_SIZE }, (_, i) => `SYM${i}`);
    findSymbolsNeedingHistoryBackfill.mockResolvedValue([]);

    await findMissingSymbolsInBatches({ exchange: "BSE", symbols, requiredFromDate: "2015-01-01" });

    expect(findSymbolsNeedingHistoryBackfill).toHaveBeenCalledTimes(1);
  });

  it("splits a symbol list larger than the batch size into multiple queries and merges results", async () => {
    const symbols = Array.from({ length: COVERAGE_BATCH_SIZE * 2 + 100 }, (_, i) => `SYM${i}`);
    findSymbolsNeedingHistoryBackfill.mockImplementation(async (input) => input.symbols.filter((_, i) => i % 2 === 0));

    const result = await findMissingSymbolsInBatches({ exchange: "BSE", symbols, requiredFromDate: "2015-01-01" });

    expect(findSymbolsNeedingHistoryBackfill).toHaveBeenCalledTimes(3);
    for (const call of findSymbolsNeedingHistoryBackfill.mock.calls) {
      expect(call[0].symbols.length).toBeLessThanOrEqual(COVERAGE_BATCH_SIZE);
      expect(call[0].exchange).toBe("BSE");
      expect(call[0].requiredFromDate).toBe("2015-01-01");
    }
    // Every-other-symbol-missing mock implementation applied per batch: result should union
    // the per-batch "missing" subsets, not just reflect the last batch or a single call.
    expect(result.length).toBe(Math.ceil(symbols.length / 2));
    expect(new Set(result).size).toBe(result.length);
  });

  it("excludes a symbol with adequate coverage from the missing result", async () => {
    findSymbolsNeedingHistoryBackfill.mockResolvedValue([]);

    const result = await findMissingSymbolsInBatches({
      exchange: "BSE",
      symbols: ["COVERED"],
      requiredFromDate: "2015-01-01",
    });

    expect(result).toEqual([]);
  });

  it("includes a symbol with missing/insufficient coverage in the result", async () => {
    findSymbolsNeedingHistoryBackfill.mockResolvedValue(["MISSING"]);

    const result = await findMissingSymbolsInBatches({
      exchange: "BSE",
      symbols: ["MISSING"],
      requiredFromDate: "2015-01-01",
    });

    expect(result).toEqual(["MISSING"]);
  });

  it("propagates a single failed batch's error rather than swallowing it", async () => {
    const symbols = Array.from({ length: COVERAGE_BATCH_SIZE * 2 }, (_, i) => `SYM${i}`);
    findSymbolsNeedingHistoryBackfill.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Query read timeout"));

    await expect(
      findMissingSymbolsInBatches({ exchange: "BSE", symbols, requiredFromDate: "2015-01-01" })
    ).rejects.toThrow("Query read timeout");
  });

  it("a failed batch never causes the result to be treated as every symbol missing", async () => {
    const symbols = Array.from({ length: COVERAGE_BATCH_SIZE * 2 }, (_, i) => `SYM${i}`);
    findSymbolsNeedingHistoryBackfill.mockRejectedValue(new Error("Query read timeout"));

    let thrown: unknown;
    try {
      await findMissingSymbolsInBatches({ exchange: "BSE", symbols, requiredFromDate: "2015-01-01" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
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
