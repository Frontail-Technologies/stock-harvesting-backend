import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: { selectDistinct: vi.fn() } }));

import * as dbClientModule from "../db/client";
import { findSymbolsWithDeepHistory } from "./reconcile-bse-candle-bootstrap-checkpoints";

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

describe("findSymbolsWithDeepHistory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty set for an empty symbol list without querying", async () => {
    const result = await findSymbolsWithDeepHistory({
      exchange: "BSE",
      symbols: [],
      windowStart: "1996-09-09",
      windowEnd: "1998-09-09",
    });

    expect(result.size).toBe(0);
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });

  it("identifies a symbol with a candle inside the early evidence window as having deep history", async () => {
    db.selectDistinct.mockReturnValueOnce(selectResult([{ symbol: "OLDCO" }]));

    const result = await findSymbolsWithDeepHistory({
      exchange: "BSE",
      symbols: ["OLDCO", "NEWCO"],
      windowStart: "1996-09-09",
      windowEnd: "1998-09-09",
    });

    expect(result.has("OLDCO")).toBe(true);
    expect(result.has("NEWCO")).toBe(false);
  });

  it("leaves a recently-listed instrument (no candle in the early window) out of the deep-history set - safe, not falsely reconciled", async () => {
    db.selectDistinct.mockReturnValueOnce(selectResult([]));

    const result = await findSymbolsWithDeepHistory({
      exchange: "BSE",
      symbols: ["NEWCO"],
      windowStart: "1996-09-09",
      windowEnd: "1998-09-09",
    });

    expect(result.size).toBe(0);
  });

  it("splits a symbol list larger than the batch size (500) into multiple bounded queries", async () => {
    const symbols = Array.from({ length: 1100 }, (_, i) => `SYM${i}`);
    db.selectDistinct
      .mockReturnValueOnce(selectResult([{ symbol: "SYM0" }]))
      .mockReturnValueOnce(selectResult([{ symbol: "SYM600" }]))
      .mockReturnValueOnce(selectResult([]));

    const result = await findSymbolsWithDeepHistory({
      exchange: "BSE",
      symbols,
      windowStart: "1996-09-09",
      windowEnd: "1998-09-09",
    });

    expect(db.selectDistinct).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(2);
  });

  it("propagates a batch query failure and aborts rather than writing any checkpoints on partial evidence", async () => {
    db.selectDistinct.mockReturnValueOnce(selectRejection(new Error("Query read timeout")));

    await expect(
      findSymbolsWithDeepHistory({ exchange: "BSE", symbols: ["A"], windowStart: "1996-09-09", windowEnd: "1998-09-09" })
    ).rejects.toThrow("Query read timeout");
  });
});
