import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), delete: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { deleteJobHistoryEntry } from "./admin.service";

const db = vi.mocked(dbClientModule.db);
const ID = "5b0c1c56-6a5b-4d5a-9a49-0d4f9a3f8c11";

function mockExisting(rows: unknown[], deleted: unknown[] = [{ id: ID }]) {
  db.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => rows }) }) } as never);
  const returning = vi.fn(async () => deleted);
  db.delete.mockReturnValue({ where: () => ({ returning }) } as never);
  return returning;
}

beforeEach(() => vi.clearAllMocks());

describe("deleteJobHistoryEntry", () => {
  it.each(["completed", "partial", "failed", "missed"])("deletes a finished %s run and audits it", async (status) => {
    mockExisting([{ status }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run" })).resolves.toEqual({ id: ID });

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "job.deleted", targetId: ID }));
  });

  it("deletes a finished provider job", async () => {
    mockExisting([{ status: "failed" }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "provider" })).resolves.toEqual({ id: ID });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ targetType: "sync_job" }));
  });

  it.each(["pending", "queued", "running"])("refuses to delete a %s job", async (status) => {
    mockExisting([{ status }]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run" })).rejects.toMatchObject({ status: 409 });
    expect(db.delete).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns not found for an unknown id", async () => {
    mockExisting([]);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run" })).rejects.toMatchObject({ status: 404 });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("refuses when the job became active between the check and the delete", async () => {
    mockExisting([{ status: "completed" }], []);

    await expect(deleteJobHistoryEntry({ actorUserId: "admin-1", id: ID, source: "run" })).rejects.toMatchObject({ status: 409 });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
