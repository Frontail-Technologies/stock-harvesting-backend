import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), delete: vi.fn(), transaction: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { bulkDeleteFailedJobHistory, deleteJobHistoryEntry } from "./admin.service";

const db = vi.mocked(dbClientModule.db);
const ID = "5b0c1c56-6a5b-4d5a-9a49-0d4f9a3f8c11";
const SECOND_ID = "8b0c1c56-6a5b-4d5a-9a49-0d4f9a3f8c22";

const NOW = new Date("2026-09-19T17:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function mockExisting(rows: Array<{ status: string; updatedAt?: Date }>, deleted: unknown[] = [{ id: ID }]) {
  const withDates = rows.map((row) => ({ updatedAt: minutesAgo(60), ...row }));
  db.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => withDates }) }) } as never);
  const returning = vi.fn(async () => deleted);
  db.delete.mockReturnValue({ where: () => ({ returning }) } as never);
  return returning;
}

beforeEach(() => vi.clearAllMocks());

describe("deleteJobHistoryEntry", () => {
  it.each(["completed", "partial", "failed", "missed"])("deletes a finished %s run and audits it", async (status) => {
    mockExisting([{ status }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run", now: NOW })).resolves.toEqual({ id: ID });

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "job.deleted", targetId: ID }));
  });

  it("deletes a finished provider job", async () => {
    mockExisting([{ status: "failed" }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "provider", now: NOW })).resolves.toEqual({ id: ID });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ targetType: "sync_job" }));
  });

  it.each(["queued", "running"])("refuses to delete a %s job that made progress within 10 minutes", async (status) => {
    mockExisting([{ status, updatedAt: minutesAgo(3) }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run", now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(db.delete).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"])("deletes a stuck %s job with no progress for over 10 minutes", async (status) => {
    mockExisting([{ status, updatedAt: minutesAgo(30) }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "provider", now: NOW })).resolves.toEqual({ id: ID });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: { status, stale: true } }));
  });

  it("never deletes a pending (scheduled) run, however old", async () => {
    mockExisting([{ status: "pending", updatedAt: minutesAgo(600) }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run", now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("returns not found for an unknown id", async () => {
    mockExisting([]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run", now: NOW })).rejects.toMatchObject({ status: 404 });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("refuses when the job became active between the check and the delete", async () => {
    mockExisting([{ status: "completed" }], []);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run", now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("bulkDeleteFailedJobHistory", () => {
  it("deletes failed rows from both job stores in one transaction and audits the result", async () => {
    const returning = vi.fn()
      .mockResolvedValueOnce([{ id: ID }])
      .mockResolvedValueOnce([{ id: SECOND_ID }]);
    const tx = { delete: vi.fn(() => ({ where: () => ({ returning }) })) };
    db.transaction.mockImplementation(async (callback) => callback(tx as never));

    await expect(bulkDeleteFailedJobHistory({
      actorUserId: "admin-1",
      jobs: [{ id: ID, source: "run" }, { id: SECOND_ID, source: "provider" }],
    })).resolves.toEqual({ deletedCount: 2 });

    expect(tx.delete).toHaveBeenCalledTimes(2);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "jobs.failed_bulk_deleted",
      metadata: expect.objectContaining({ requestedCount: 2, deletedCount: 2 }),
    }));
  });
});

describe("toJobListPayload", () => {
  it("keeps scalar fields and drops large arrays and nested objects from the job list payload", async () => {
    const { toJobListPayload } = await import("./admin.service");

    expect(
      toJobListPayload({
        exchange: "BSE_IDX",
        backfilled: 86,
        indexCount: 134,
        progress: 0,
        note: null,
        failedSymbols: ["150M1I", "1000EQ"],
        details: { a: 1 },
      }),
    ).toEqual({ exchange: "BSE_IDX", backfilled: 86, indexCount: 134, progress: 0, note: null });
  });
});
