import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), insert: vi.fn() } }));

import * as dbClientModule from "../../db/client";
import {
  isCandleBootstrapCheckpointSatisfied,
  readCandleBootstrapCheckpointsInBatches,
  upsertCandleBootstrapCheckpoint,
  type CandleBootstrapCheckpoint,
} from "./market-data.candle-bootstrap-checkpoints";

const db = vi.mocked(dbClientModule.db);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

function selectRejection(error: unknown) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (_resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.reject(error).then(undefined, reject),
  };
  return chain as never;
}

describe("readCandleBootstrapCheckpointsInBatches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty map for an empty symbol list without querying", async () => {
    const result = await readCandleBootstrapCheckpointsInBatches({
      exchange: "BSE",
      symbols: [],
      timeframe: "1D",
      kind: "bse_historical_daily",
    });

    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("issues one query for a symbol list at or under the batch size (500)", async () => {
    const symbols = Array.from({ length: 500 }, (_, i) => `SYM${i}`);
    db.select.mockReturnValueOnce(selectResult([]));

    await readCandleBootstrapCheckpointsInBatches({ exchange: "BSE", symbols, timeframe: "1D", kind: "k" });

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("splits a symbol list larger than the batch size into multiple bounded queries and merges results", async () => {
    const symbols = Array.from({ length: 1100 }, (_, i) => `SYM${i}`);
    db.select
      .mockReturnValueOnce(selectResult([{ symbol: "SYM0", status: "success", bootstrapVersion: 1, requestedFrom: "1996-09-09" }]))
      .mockReturnValueOnce(selectResult([{ symbol: "SYM600", status: "success", bootstrapVersion: 1, requestedFrom: "1996-09-09" }]))
      .mockReturnValueOnce(selectResult([{ symbol: "SYM1050", status: "failed", bootstrapVersion: 1, requestedFrom: "1996-09-09" }]));

    const result = await readCandleBootstrapCheckpointsInBatches({
      exchange: "BSE",
      symbols,
      timeframe: "1D",
      kind: "bse_historical_daily",
    });

    expect(db.select).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(3);
    expect(result.get("SYM0")?.status).toBe("success");
    expect(result.get("SYM1050")?.status).toBe("failed");
  });

  it("propagates a batch query failure rather than swallowing it", async () => {
    const symbols = Array.from({ length: 600 }, (_, i) => `SYM${i}`);
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectRejection(new Error("Query read timeout")));

    await expect(
      readCandleBootstrapCheckpointsInBatches({ exchange: "BSE", symbols, timeframe: "1D", kind: "k" })
    ).rejects.toThrow("Query read timeout");
  });

  it("a failed batch never resolves to a result implying every symbol is uncovered-but-successful", async () => {
    const symbols = Array.from({ length: 600 }, (_, i) => `SYM${i}`);
    db.select.mockReturnValueOnce(selectRejection(new Error("Query read timeout")));

    let thrown: unknown;
    try {
      await readCandleBootstrapCheckpointsInBatches({ exchange: "BSE", symbols, timeframe: "1D", kind: "k" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("isCandleBootstrapCheckpointSatisfied", () => {
  const requirement = { bootstrapVersion: 1, requestedFrom: "1996-09-09" };

  it("is not satisfied when there is no checkpoint at all", () => {
    expect(isCandleBootstrapCheckpointSatisfied(undefined, requirement)).toBe(false);
  });

  it("is satisfied by a success checkpoint whose requestedFrom reaches at least as far back", () => {
    const checkpoint: CandleBootstrapCheckpoint = {
      symbol: "TCS",
      status: "success",
      bootstrapVersion: 1,
      requestedFrom: "1996-09-09",
    };
    expect(isCandleBootstrapCheckpointSatisfied(checkpoint, requirement)).toBe(true);
  });

  it("is satisfied for a recently-listed instrument whose checkpoint requestedFrom equals the request even though its data starts later", () => {
    // The checkpoint stores the *requested* from-date used for the run, not the instrument's
    // actual earliest candle - so a company that listed in 2015 but was fully bootstrapped
    // under a 1996-09-09 request is still correctly treated as complete on resume.
    const checkpoint: CandleBootstrapCheckpoint = {
      symbol: "NEWLISTCO",
      status: "success",
      bootstrapVersion: 1,
      requestedFrom: "1996-09-09",
    };
    expect(isCandleBootstrapCheckpointSatisfied(checkpoint, requirement)).toBe(true);
  });

  it("is not satisfied by a partial checkpoint", () => {
    const checkpoint: CandleBootstrapCheckpoint = {
      symbol: "TCS",
      status: "partial",
      bootstrapVersion: 1,
      requestedFrom: "1996-09-09",
    };
    expect(isCandleBootstrapCheckpointSatisfied(checkpoint, requirement)).toBe(false);
  });

  it("is not satisfied by a failed checkpoint", () => {
    const checkpoint: CandleBootstrapCheckpoint = {
      symbol: "TCS",
      status: "failed",
      bootstrapVersion: 1,
      requestedFrom: "1996-09-09",
    };
    expect(isCandleBootstrapCheckpointSatisfied(checkpoint, requirement)).toBe(false);
  });

  it("is not satisfied when the checkpoint's bootstrap version differs from what's requested now", () => {
    const checkpoint: CandleBootstrapCheckpoint = {
      symbol: "TCS",
      status: "success",
      bootstrapVersion: 1,
      requestedFrom: "1996-09-09",
    };
    expect(isCandleBootstrapCheckpointSatisfied(checkpoint, { bootstrapVersion: 2, requestedFrom: "1996-09-09" })).toBe(
      false
    );
  });

  it("is not satisfied when a materially earlier history range is now requested than the checkpoint covered", () => {
    const checkpoint: CandleBootstrapCheckpoint = {
      symbol: "TCS",
      status: "success",
      bootstrapVersion: 1,
      requestedFrom: "2010-01-01",
    };
    expect(isCandleBootstrapCheckpointSatisfied(checkpoint, { bootstrapVersion: 1, requestedFrom: "1996-09-09" })).toBe(
      false
    );
  });
});

describe("upsertCandleBootstrapCheckpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues one insert-with-onConflictDoUpdate call", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    db.insert.mockReturnValueOnce({ values } as never);

    await upsertCandleBootstrapCheckpoint({
      exchange: "BSE",
      symbol: "TCS",
      timeframe: "1D",
      kind: "bse_historical_daily",
      bootstrapVersion: 1,
      status: "success",
      requestedFrom: "1996-09-09",
      requestedTo: "2026-09-09",
      candleCount: 5000,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });
});
