import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { delete: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("../../shared/cache", () => ({ invalidateCacheByPrefix: vi.fn() }));
vi.mock("../jobs/queues", () => ({ removeQueuedCollectionPrepareJobs: vi.fn() }));
vi.mock("../market-data/dashboard-snapshots.service", () => ({ invalidateCollectionSnapshots: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { invalidateCacheByPrefix } from "../../shared/cache";
import { removeQueuedCollectionPrepareJobs } from "../jobs/queues";
import { invalidateCollectionSnapshots } from "../market-data/dashboard-snapshots.service";
import { marketCollections } from "../../db/schema";
import { bulkDeleteMarketCollections, deleteMarketCollection } from "./market-collection-deletion.service";

const db = vi.mocked(dbClientModule.db);

// Mimics drizzle's chainable, awaitable delete query builder (where/returning return `this`, awaited at any point).
function deleteResult(rows: unknown[]) {
  const chain = {
    where: () => chain,
    returning: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

describe("deleteMarketCollection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the row, invalidates cache/snapshots/queued jobs, and writes an audit log", async () => {
    db.delete.mockReturnValueOnce(deleteResult([{ id: "col-1", code: "NIFTY50", name: "NIFTY 50" }]));

    const result = await deleteMarketCollection({ id: "col-1", actorUserId: "admin-1" });

    expect(result).toEqual({ deleted: true, id: "col-1" });
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledWith(marketCollections);
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith("collections:list");
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith("collectionMembers:NIFTY50:");
    expect(invalidateCollectionSnapshots).toHaveBeenCalledWith("col-1");
    expect(removeQueuedCollectionPrepareJobs).toHaveBeenCalledWith(["col-1"]);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        action: "market_collection.deleted",
        targetId: "col-1",
        metadata: { code: "NIFTY50", name: "NIFTY 50" },
      })
    );
  });

  it("throws not-found when no row matches (also covers an already-preparing/any-status collection - no status gate exists)", async () => {
    db.delete.mockReturnValueOnce(deleteResult([]));

    await expect(deleteMarketCollection({ id: "missing", actorUserId: "admin-1" })).rejects.toThrow(
      "Collection not found"
    );
    expect(invalidateCollectionSnapshots).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("bulkDeleteMarketCollections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes every matched row in one statement and reports counts", async () => {
    db.delete.mockReturnValueOnce(
      deleteResult([
        { id: "col-1", code: "A", name: "A" },
        { id: "col-2", code: "B", name: "B" },
      ])
    );

    const result = await bulkDeleteMarketCollections({
      ids: ["col-1", "col-2"],
      actorUserId: "admin-1",
    });

    expect(result).toEqual({ requestedCount: 2, deletedCount: 2, missingCount: 0, missingIds: [] });
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(invalidateCollectionSnapshots).toHaveBeenCalledWith("col-1");
    expect(invalidateCollectionSnapshots).toHaveBeenCalledWith("col-2");
    expect(removeQueuedCollectionPrepareJobs).toHaveBeenCalledWith(["col-1", "col-2"]);
  });

  it("deduplicates repeated ids server-side before counting them as requested", async () => {
    db.delete.mockReturnValueOnce(deleteResult([{ id: "col-1", code: "A", name: "A" }]));

    const result = await bulkDeleteMarketCollections({
      ids: ["col-1", "col-1", "col-1"],
      actorUserId: "admin-1",
    });

    expect(result.requestedCount).toBe(1);
    expect(result.deletedCount).toBe(1);
  });

  it("reports already-gone ids as missing without failing the whole request", async () => {
    db.delete.mockReturnValueOnce(deleteResult([{ id: "col-1", code: "A", name: "A" }]));

    const result = await bulkDeleteMarketCollections({
      ids: ["col-1", "col-2", "col-3"],
      actorUserId: "admin-1",
    });

    expect(result).toEqual({
      requestedCount: 3,
      deletedCount: 1,
      missingCount: 2,
      missingIds: ["col-2", "col-3"],
    });
  });

  it("writes one audit log with compact metadata, never a full membership payload", async () => {
    db.delete.mockReturnValueOnce(
      deleteResult([
        { id: "col-1", code: "A", name: "A" },
        { id: "col-2", code: "B", name: "B" },
      ])
    );

    await bulkDeleteMarketCollections({ ids: ["col-1", "col-2"], actorUserId: "admin-1" });

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "market_collection.bulk_deleted",
        metadata: { requestedCount: 2, deletedCount: 2, missingCount: 0, codes: ["A", "B"] },
      })
    );
  });

  it("no-ops cleanup entirely when nothing matched (all requested ids already gone)", async () => {
    db.delete.mockReturnValueOnce(deleteResult([]));

    const result = await bulkDeleteMarketCollections({ ids: ["ghost"], actorUserId: "admin-1" });

    expect(result).toEqual({ requestedCount: 1, deletedCount: 0, missingCount: 1, missingIds: ["ghost"] });
    expect(invalidateCollectionSnapshots).not.toHaveBeenCalled();
    expect(removeQueuedCollectionPrepareJobs).not.toHaveBeenCalled();
    // Still audited, so a bulk request that matched nothing is traceable too.
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});
