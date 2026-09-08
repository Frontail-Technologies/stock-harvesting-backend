import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn() } }));

import * as dbClientModule from "../../db/client";
import { findSymbolsNeedingHistoryBackfill } from "./market-data.candles";

const db = vi.mocked(dbClientModule.db);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

describe("findSymbolsNeedingHistoryBackfill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] immediately for an empty symbol list, no query issued", async () => {
    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols: [],
      requiredFromDate: "2016-09-01",
    });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("excludes a symbol whose earliest stored candle already reaches the required date", async () => {
    db.select.mockReturnValueOnce(
      selectResult([
        { symbol: "RELIANCE", earliest: "2010-01-04" },
        { symbol: "NEWCO", earliest: "2025-06-01" },
      ])
    );

    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols: ["RELIANCE", "NEWCO"],
      requiredFromDate: "2016-09-01",
    });

    expect(result).toEqual(["NEWCO"]);
  });

  it("includes a symbol with no stored candles at all", async () => {
    db.select.mockReturnValueOnce(selectResult([{ symbol: "RELIANCE", earliest: "2010-01-04" }]));

    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols: ["RELIANCE", "NOHISTORY"],
      requiredFromDate: "2016-09-01",
    });

    expect(result).toEqual(["NOHISTORY"]);
  });
});
