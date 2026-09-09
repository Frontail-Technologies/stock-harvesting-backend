import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() } }));
vi.mock("../modules/security/passwords", () => ({
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

import * as dbClientModule from "../db/client";
import { parseArgs, resolveSeedAdminInput, seedAdmin } from "./seed-admin";

const db = vi.mocked(dbClientModule.db);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain as never;
}

describe("parseArgs", () => {
  it("parses --key=value pairs and boolean flags", () => {
    expect(parseArgs(["--email=a@b.com", "--password=hunter22", "--force-password"])).toEqual({
      email: "a@b.com",
      password: "hunter22",
      "force-password": true,
    });
  });
});

describe("resolveSeedAdminInput", () => {
  it("prefers CLI args over env vars", () => {
    const input = resolveSeedAdminInput(
      { email: "cli@example.com", password: "clipassword1" },
      { ADMIN_SEED_EMAIL: "env@example.com", ADMIN_SEED_PASSWORD: "envpassword1" }
    );
    expect(input.email).toBe("cli@example.com");
    expect(input.password).toBe("clipassword1");
  });

  it("falls back to env vars when CLI args are absent", () => {
    const input = resolveSeedAdminInput(
      {},
      { ADMIN_SEED_EMAIL: "env@example.com", ADMIN_SEED_PASSWORD: "envpassword1" }
    );
    expect(input.email).toBe("env@example.com");
  });

  it("defaults name to 'Admin' when not provided", () => {
    const input = resolveSeedAdminInput(
      { email: "a@b.com", password: "password1" },
      {}
    );
    expect(input.name).toBe("Admin");
  });

  it("throws when no email is available", () => {
    expect(() => resolveSeedAdminInput({ password: "password1" }, {})).toThrow(/email/i);
  });

  it("throws on an invalid email", () => {
    expect(() => resolveSeedAdminInput({ email: "not-an-email", password: "password1" }, {})).toThrow(
      /email/i
    );
  });

  it("throws when no password is available", () => {
    expect(() => resolveSeedAdminInput({ email: "a@b.com" }, {})).toThrow(/password/i);
  });

  it("throws when the password is too short", () => {
    expect(() => resolveSeedAdminInput({ email: "a@b.com", password: "short" }, {})).toThrow(
      /password/i
    );
  });

  it("defaults forcePassword to false", () => {
    const input = resolveSeedAdminInput({ email: "a@b.com", password: "password1" }, {});
    expect(input.forcePassword).toBe(false);
  });
});

describe("seedAdmin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a new admin account when the email doesn't exist yet", async () => {
    db.select.mockReturnValueOnce(selectResult([]));
    const values = vi.fn().mockResolvedValue(undefined);
    db.insert.mockReturnValueOnce({ values } as never);

    const outcome = await seedAdmin({
      email: "new-admin@example.com",
      password: "password123",
      name: "New Admin",
      forcePassword: false,
    });

    expect(outcome).toBe("created");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new-admin@example.com", role: "admin" })
    );
  });

  it("promotes an existing non-admin user to admin without touching their password", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "u1", email: "user@example.com", role: "user", passwordHash: "existing-hash" }])
    );
    const set = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    db.update.mockReturnValueOnce({ set } as never);

    const outcome = await seedAdmin({
      email: "user@example.com",
      password: "password123",
      name: "Whoever",
      forcePassword: false,
    });

    expect(outcome).toBe("promoted");
    const setArg = set.mock.calls[0][0];
    expect(setArg.role).toBe("admin");
    expect(setArg.passwordHash).toBeUndefined();
  });

  it("is a no-op when the user is already an admin and --force-password wasn't given", async () => {
    db.select.mockReturnValueOnce(selectResult([{ id: "u1", email: "admin@example.com", role: "admin" }]));

    const outcome = await seedAdmin({
      email: "admin@example.com",
      password: "password123",
      name: "Whoever",
      forcePassword: false,
    });

    expect(outcome).toBe("already-admin");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("resets the password of an existing admin only when --force-password is given", async () => {
    db.select.mockReturnValueOnce(selectResult([{ id: "u1", email: "admin@example.com", role: "admin" }]));
    const set = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    db.update.mockReturnValueOnce({ set } as never);

    const outcome = await seedAdmin({
      email: "admin@example.com",
      password: "newpassword1",
      name: "Whoever",
      forcePassword: true,
    });

    expect(outcome).toBe("password-reset");
    const setArg = set.mock.calls[0][0];
    expect(setArg.passwordHash).toBe("hashed:newpassword1");
  });

  it("promotes and resets the password together when both apply", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "u1", email: "user@example.com", role: "user" }])
    );
    const set = vi.fn((_values: Record<string, unknown>) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    db.update.mockReturnValueOnce({ set } as never);

    const outcome = await seedAdmin({
      email: "user@example.com",
      password: "newpassword1",
      name: "Whoever",
      forcePassword: true,
    });

    expect(outcome).toBe("promoted");
    const setArg = set.mock.calls[0][0];
    expect(setArg.role).toBe("admin");
    expect(setArg.passwordHash).toBe("hashed:newpassword1");
  });
});
