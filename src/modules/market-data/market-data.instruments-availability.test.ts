import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn() } }));

import * as dbClientModule from "../../db/client";
import { hasActiveInstruments } from "./market-data.instruments";

const db = vi.mocked(dbClientModule.db);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain as never;
}

describe("hasActiveInstruments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when at least one matching row exists", async () => {
    db.select.mockReturnValueOnce(selectResult([{ id: "1" }]));

    await expect(hasActiveInstruments("BSE")).resolves.toBe(true);
  });

  it("returns false when no matching row exists", async () => {
    db.select.mockReturnValueOnce(selectResult([]));

    await expect(hasActiveInstruments("NSE")).resolves.toBe(false);
  });

  it("accepts an optional provider filter without changing the exchange/active semantics", async () => {
    db.select.mockReturnValueOnce(selectResult([{ id: "1" }]));

    await expect(hasActiveInstruments("NSE", "zerodha")).resolves.toBe(true);
  });
});
