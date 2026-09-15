import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), insert: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { createAdminUser } from "./admin.service";

const db = vi.mocked(dbClientModule.db);
const writeAuditLogMock = vi.mocked(writeAuditLog);

function mockSelectChain(rows: unknown[]) {
  db.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  } as never);
}

function mockInsertChain(row: unknown) {
  db.insert.mockReturnValue({
    values: () => ({ returning: async () => [row] }),
  } as never);
}

describe("createAdminUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new user with role=admin, a hashed password, and an already-verified email", async () => {
    mockSelectChain([]);
    mockInsertChain({
      id: "user-1",
      name: "New Admin",
      email: "newadmin@example.com",
      role: "admin",
      plan: "free",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await createAdminUser({
      actorUserId: "actor-1",
      email: "NewAdmin@Example.com",
      name: "New Admin",
      password: "correct horse battery",
    });

    expect(result.email).toBe("newadmin@example.com");
    expect(result.role).toBe("admin");
    expect(result).not.toHaveProperty("passwordHash");

    const insertCall = db.insert.mock.results[0].value as { values: (v: unknown) => unknown };
    expect(insertCall).toBeDefined();
  });

  it("normalizes the email before checking uniqueness and inserting", async () => {
    function findStringValue(node: unknown): string | undefined {
      if (!node || typeof node !== "object") return undefined;
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (chunk && typeof chunk === "object" && "value" in chunk && typeof (chunk as { value: unknown }).value === "string") {
            return (chunk as { value: string }).value;
          }
          const found = findStringValue(chunk);
          if (found) return found;
        }
      }
      return undefined;
    }

    let queriedEmail: string | undefined;
    db.select.mockReturnValue({
      from: () => ({
        where: (condition: unknown) => {
          queriedEmail = findStringValue(condition);
          return { limit: async () => [] };
        },
      }),
    } as never);
    mockInsertChain({
      id: "user-1",
      name: "New Admin",
      email: "newadmin@example.com",
      role: "admin",
      plan: "free",
      createdAt: new Date(),
    });

    await createAdminUser({
      actorUserId: "actor-1",
      email: "  NewAdmin@Example.com  ",
      name: "New Admin",
      password: "correct horse battery",
    });

    expect(queriedEmail).toBe("newadmin@example.com");
  });

  it("rejects when a user with that email already exists", async () => {
    mockSelectChain([{ id: "existing-user" }]);

    await expect(
      createAdminUser({
        actorUserId: "actor-1",
        email: "taken@example.com",
        name: "New Admin",
        password: "correct horse battery",
      })
    ).rejects.toThrow(/already exists/);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("writes an audit log recording who created the account", async () => {
    mockSelectChain([]);
    mockInsertChain({
      id: "user-1",
      name: "New Admin",
      email: "newadmin@example.com",
      role: "admin",
      plan: "free",
      createdAt: new Date(),
    });

    await createAdminUser({
      actorUserId: "actor-1",
      email: "newadmin@example.com",
      name: "New Admin",
      password: "correct horse battery",
    });

    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "actor-1",
        action: "user.created",
        targetType: "user",
        targetId: "user-1",
      })
    );
  });
});
