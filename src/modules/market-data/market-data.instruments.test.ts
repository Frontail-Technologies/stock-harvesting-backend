import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../../shared/logger";
import { upsertInstruments } from "./market-data.instruments";

const PROVIDER = "global-datafeeds";

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const pass = () => chain;
  chain.from = pass;
  chain.where = pass;
  chain.limit = pass;
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function insertChain(captured: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.values = (value: unknown) => {
    captured.push(value);
    return chain;
  };
  chain.onConflictDoUpdate = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

function updateChain(captured: unknown[], rejectWith?: unknown) {
  const chain: Record<string, unknown> = {};
  chain.set = (value: unknown) => {
    captured.push(value);
    return chain;
  };
  chain.where = () => chain;
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
    rejectWith !== undefined
      ? Promise.reject(rejectWith).then(resolve, reject)
      : Promise.resolve(undefined).then(resolve, reject);
  return chain;
}

function createFakeDb(selectQueue: unknown[][], updateRejections: unknown[] = []) {
  let selectIndex = 0;
  let updateIndex = 0;
  const insertValues: unknown[] = [];
  const updateSets: unknown[] = [];

  const db = {
    select: vi.fn(() => selectChain(selectQueue[selectIndex++] ?? [])),
    insert: vi.fn(() => insertChain(insertValues)),
    update: vi.fn(() => updateChain(updateSets, updateRejections[updateIndex++])),
  };

  return { db, insertValues, updateSets };
}

beforeEach(() => {
  vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
});

describe("upsertInstruments - provider+instrumentToken rename handling", () => {
  it("same provider, same token, same symbol -> normal update, no rename path taken", async () => {
    const { db, insertValues, updateSets } = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "ABC", instrumentToken: "T1" }],
    ]);

    await upsertInstruments(
      [{ exchange: "BSE", symbol: "ABC", name: "ABC Ltd", instrumentToken: "T1" }],
      PROVIDER,
      db as never
    );

    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertValues[0]).toEqual([
      expect.objectContaining({ exchange: "BSE", symbol: "ABC", instrumentToken: "T1" }),
    ]);
    expect(updateSets).toHaveLength(0);
  });

  it("same provider, same token, new symbol -> renames in place, does not insert a second row", async () => {
    const { db, insertValues, updateSets } = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "OLD", instrumentToken: "T1" }],
      [],
    ]);

    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "New Name", instrumentToken: "T1" }],
      PROVIDER,
      db as never
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateSets[0]).toMatchObject({ symbol: "NEW", instrumentToken: "T1", active: true });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rename also updates the current name", async () => {
    const { db, updateSets } = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "OLD", instrumentToken: "T1" }],
      [],
    ]);

    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "Renamed Company Ltd", instrumentToken: "T1" }],
      PROVIDER,
      db as never
    );

    expect(updateSets[0]).toMatchObject({ symbol: "NEW", name: "Renamed Company Ltd" });
  });

  it("new symbol already belongs to another instrument -> no update, no insert, conflict reported", async () => {
    const { db, insertValues, updateSets } = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "OLD", instrumentToken: "T1" }],
      [{ id: "inst-2", exchange: "BSE", symbol: "NEW" }],
    ]);

    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "New Name", instrumentToken: "T1" }],
      PROVIDER,
      db as never
    );

    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(updateSets).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conflicts: [
          expect.objectContaining({
            instrumentId: "inst-1",
            fromSymbol: "OLD",
            toSymbol: "NEW",
            conflictingInstrumentId: "inst-2",
          }),
        ],
      }),
      expect.any(String)
    );
  });

  it("different token -> not treated as a rename, inserted/updated as its own identity", async () => {
    const { db, insertValues, updateSets } = createFakeDb([[]]);

    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "New Name", instrumentToken: "T2" }],
      PROVIDER,
      db as never
    );

    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertValues[0]).toEqual([
      expect.objectContaining({ symbol: "NEW", instrumentToken: "T2" }),
    ]);
    expect(updateSets).toHaveLength(0);
  });

  it("repeated sync after a rename is idempotent - the second run no longer renames", async () => {
    const first = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "OLD", instrumentToken: "T1" }],
      [],
    ]);
    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "New Name", instrumentToken: "T1" }],
      PROVIDER,
      first.db as never
    );
    expect(first.db.update).toHaveBeenCalledTimes(1);

    const second = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "NEW", instrumentToken: "T1" }],
    ]);
    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "New Name", instrumentToken: "T1" }],
      PROVIDER,
      second.db as never
    );

    expect(second.db.update).not.toHaveBeenCalled();
    expect(second.db.insert).toHaveBeenCalledTimes(1);
  });

  it("does not create a duplicate instrument row when applying a rename", async () => {
    const { db, insertValues } = createFakeDb([
      [{ id: "inst-1", exchange: "BSE", symbol: "OLD", instrumentToken: "T1" }],
      [],
    ]);

    await upsertInstruments(
      [{ exchange: "BSE", symbol: "NEW", name: "New Name", instrumentToken: "T1" }],
      PROVIDER,
      db as never
    );

    expect(db.insert).not.toHaveBeenCalled();
    expect(insertValues).toHaveLength(0);
  });
});
