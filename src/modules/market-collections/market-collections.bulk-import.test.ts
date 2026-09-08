import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), insert: vi.fn(), transaction: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("../../shared/cache", () => ({
  getOrSetCache: vi.fn((_key: string, fn: () => unknown) => fn()),
  invalidateCacheByPrefix: vi.fn(),
}));
vi.mock("../market-data/dashboard-snapshots.service", () => ({
  getOrComputeCollectionRelativeStrengthBase: vi.fn(),
  getOrComputeWeeklyStrongSnapshot: vi.fn(),
  invalidateCollectionSnapshots: vi.fn(),
}));

import * as dbClientModule from "../../db/client";
import {
  marketCollectionMembers,
  marketCollections,
  marketCollectionVersionMembers,
  marketCollectionVersions,
  weeklyStrongBacktestRuns,
} from "../../db/schema";
import {
  findCollectionByCode,
  importBulkFile,
  previewBulkImportFile,
} from "./market-collections.service";

const db = vi.mocked(dbClientModule.db);

// Mimics drizzle's chainable, awaitable select query builder (from/where/
// orderBy/limit all return `this`, awaited at any point) - same pattern
// already established in weekly-strong-backtest.membership-changes.test.ts,
// since no real Postgres is reachable in this environment.
function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

describe("findCollectionByCode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the matching row when one exists for the exchange+code", async () => {
    db.select.mockReturnValueOnce(selectResult([{ id: "col-1", code: "BANK_NIFTY", exchange: "BSE" }]));

    const result = await findCollectionByCode("BSE", "bank_nifty");

    expect(result).toEqual({ id: "col-1", code: "BANK_NIFTY", exchange: "BSE" });
  });

  it("returns null when no row matches", async () => {
    db.select.mockReturnValueOnce(selectResult([]));

    const result = await findCollectionByCode("BSE", "NOPE");

    expect(result).toBeNull();
  });
});

describe("previewBulkImportFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no existing collection: every matched symbol classifies as new, existingCollectionId is null", async () => {
    db.select
      .mockReturnValueOnce(selectResult([])) // findCollectionByCode: no match
      .mockReturnValueOnce(selectResult([{ id: "instrument-1", symbol: "RELIANCE" }])); // resolveCollectionInstrumentMatches

    const result = await previewBulkImportFile({
      exchange: "BSE",
      filename: "BSE New Seg.csv",
      csvContent: "symbol\nRELIANCE",
    });

    expect(result.existingCollectionId).toBeNull();
    expect(result.name).toBe("BSE New Seg");
    expect(result.code).toBe("BSE_NEW_SEG");
    expect(result.report.matched).toEqual([{ symbol: "RELIANCE", instrumentId: "instrument-1", status: "new" }]);
    expect(result.report.toDeactivate).toEqual([]);
    // A null collection id must never trigger the current-members join query -
    // exactly 2 db.select calls total (find-by-code, instrument match), not 3.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("existing collection: classifies against its real current membership, existingCollectionId is that id", async () => {
    db.select
      .mockReturnValueOnce(selectResult([{ id: "col-1", code: "NIFTYBANK", exchange: "BSE" }])) // findCollectionByCode
      .mockReturnValueOnce(selectResult([{ id: "instrument-2", symbol: "HDFCBANK" }])) // instrument match
      .mockReturnValueOnce(selectResult([])); // current members: none yet

    const result = await previewBulkImportFile({
      exchange: "BSE",
      filename: "BSE Bank Nifty [NIFTYBANK].csv",
      csvContent: "symbol\nHDFCBANK",
    });

    expect(result.existingCollectionId).toBe("col-1");
    expect(result.report.matched).toEqual([{ symbol: "HDFCBANK", instrumentId: "instrument-2", status: "new" }]);
  });
});

// Models the same "pending vs committed" transaction semantic as
// market-data.backfill-atomicity.test.ts: writes land in `pending`, and
// `committed` only becomes `pending` if the whole callback resolves. A
// thrown error partway through (simulated via `failAt`) leaves `committed`
// exactly as it was - proving create-then-import rolls back as one unit
// rather than leaving an orphaned empty collection behind.
function createFakeTransactionDb(options: { failAt?: "memberUpsert" | "versionInsert" } = {}) {
  let committedCollections: Array<{ id: string; code: string; exchange: string }> = [];
  let transactionCount = 0;
  let nextId = 1;

  (
    db.transaction as unknown as {
      mockImplementation: (fn: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>) => void;
    }
  ).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    transactionCount += 1;
    const pendingCollections = [...committedCollections];

    const tx = {
      select: (_shape: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond: unknown) => selectResult([]),
        }),
      }),
      insert: (table: unknown) => ({
        values: (rows: unknown) => ({
          returning: async () => {
            if (table === marketCollections) {
              const row = { id: `new-collection-${nextId++}`, ...(rows as Record<string, unknown>) };
              pendingCollections.push(row as never);
              return [row];
            }
            if (table === marketCollectionVersions) {
              if (options.failAt === "versionInsert") throw new Error("simulated version insert failure");
              return [{ id: "version-1" }];
            }
            return [rows];
          },
          onConflictDoUpdate: async (_opts: unknown) => {
            if (table === marketCollectionMembers && options.failAt === "memberUpsert") {
              throw new Error("simulated member upsert failure");
            }
          },
        }),
      }),
      update: (_table: unknown) => ({
        set: (_changes: unknown) => ({
          where: async (_cond: unknown) => {},
        }),
      }),
      delete: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          returning: async () => [],
        }),
      }),
    };

    const result = await callback(tx);
    // Only reached if the callback above didn't throw.
    committedCollections = pendingCollections;
    return result;
  });

  return {
    getCommittedCollections: () => committedCollections,
    getTransactionCount: () => transactionCount,
  };
}

describe("importBulkFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create path: no existing collection -> creates it and imports membership atomically in one transaction", async () => {
    const { getCommittedCollections } = createFakeTransactionDb();
    db.select
      .mockReturnValueOnce(selectResult([])) // findCollectionByCode (service-level, pre-tx)
      .mockReturnValueOnce(selectResult([{ id: "instrument-1", symbol: "RELIANCE" }])); // instrument match

    const result = await importBulkFile({
      exchange: "BSE",
      filename: "BSE New Seg.csv",
      csvContent: "symbol\nRELIANCE",
      effectiveFrom: "2026-09-04",
      actorUserId: "user-1",
    });

    expect(result.created).toBe(true);
    expect(result.name).toBe("BSE New Seg");
    expect(result.code).toBe("BSE_NEW_SEG");
    expect(getCommittedCollections()).toHaveLength(1);
    expect(getCommittedCollections()[0].code).toBe("BSE_NEW_SEG");
  });

  it("create path: a failure later in the same transaction rolls back the new collection too", async () => {
    const { getCommittedCollections } = createFakeTransactionDb({ failAt: "memberUpsert" });
    db.select
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: "instrument-1", symbol: "RELIANCE" }]));

    await expect(
      importBulkFile({
        exchange: "BSE",
        filename: "BSE New Seg.csv",
        csvContent: "symbol\nRELIANCE",
        effectiveFrom: "2026-09-04",
        actorUserId: "user-1",
      })
    ).rejects.toThrow("simulated member upsert failure");

    // The collection insert ran before the failure, but nothing committed -
    // no orphaned empty collection is left behind.
    expect(getCommittedCollections()).toHaveLength(0);
  });

  it("update path: an existing collection retains its id and is never re-created", async () => {
    createFakeTransactionDb();
    const existingRow = { id: "col-1", code: "NIFTYBANK", exchange: "BSE", sourceName: null, sourceDate: null };
    db.select
      .mockReturnValueOnce(selectResult([existingRow])) // findCollectionByCode (importBulkFile)
      .mockReturnValueOnce(selectResult([existingRow])) // requireCollectionById (importCollectionCsv)
      .mockReturnValueOnce(selectResult([{ id: "instrument-2", symbol: "HDFCBANK" }])) // instrument match
      .mockReturnValueOnce(selectResult([])); // current members (pre-tx classify)

    const result = await importBulkFile({
      exchange: "BSE",
      filename: "BSE Bank Nifty [NIFTYBANK].csv",
      csvContent: "symbol\nHDFCBANK",
      effectiveFrom: "2026-09-04",
      actorUserId: "user-1",
    });

    expect(result.created).toBe(false);
    expect(result.code).toBe("NIFTYBANK");
  });
});
