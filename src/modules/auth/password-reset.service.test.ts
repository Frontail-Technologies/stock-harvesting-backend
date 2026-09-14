import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), insert: vi.fn(), transaction: vi.fn() } }));
vi.mock("./auth-email.service", () => ({ sendPasswordResetEmail: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { sendPasswordResetEmail } from "./auth-email.service";
import { GENERIC_PASSWORD_RESET_REQUEST_MESSAGE } from "./auth.constants";
import { requestPasswordReset, resetPassword } from "./password-reset.service";

const db = vi.mocked(dbClientModule.db);
const sendPasswordResetEmailMock = vi.mocked(sendPasswordResetEmail);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requestPasswordReset", () => {
  it("sends a reset email and stores a token for an existing password account", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "user-1", email: "user@example.com", name: "Test User", passwordHash: "hash" }]),
    );
    const values = vi.fn().mockResolvedValue(undefined);
    db.insert.mockReturnValueOnce({ values } as never);

    const result = await requestPasswordReset({ email: "user@example.com" });

    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: GENERIC_PASSWORD_RESET_REQUEST_MESSAGE });
  });

  it("returns the same generic message and sends no email when no account exists", async () => {
    db.select.mockReturnValueOnce(selectResult([]));

    const result = await requestPasswordReset({ email: "ghost@example.com" });

    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ message: GENERIC_PASSWORD_RESET_REQUEST_MESSAGE });
  });

  it("returns the same generic message and sends no email for a Google-only account (nothing to reset)", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "user-2", email: "google@example.com", name: "Google User", passwordHash: null }]),
    );

    const result = await requestPasswordReset({ email: "google@example.com" });

    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ message: GENERIC_PASSWORD_RESET_REQUEST_MESSAGE });
  });
});

type FakeTokenRow = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

function mockTransaction(tokenRow: FakeTokenRow | null) {
  const setCalls: Array<{ table: unknown; values: unknown }> = [];
  const whereCalls: unknown[] = [];

  (db.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>) = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: () => Promise.resolve(tokenRow ? [tokenRow] : []),
              }),
            }),
          }),
        }),
        update: (table: unknown) => ({
          set: (values: unknown) => ({
            where: (cond: unknown) => {
              setCalls.push({ table, values });
              whereCalls.push(cond);
              return Promise.resolve();
            },
          }),
        }),
      };
      return cb(tx);
    },
  ) as never;

  return { setCalls };
}

describe("resetPassword", () => {
  it("succeeds with a valid, unexpired, unused token and invalidates existing sessions", async () => {
    const tokenRow: FakeTokenRow = {
      id: "token-1",
      userId: "user-1",
      tokenHash: "irrelevant-in-mock",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      consumedAt: null,
    };
    const { setCalls } = mockTransaction(tokenRow);

    const result = await resetPassword({ token: "raw-token", password: "newpassword123" });

    expect(result).toEqual({ ok: true });
    expect(setCalls).toHaveLength(3);
  });

  it("rejects an expired token", async () => {
    const tokenRow: FakeTokenRow = {
      id: "token-1",
      userId: "user-1",
      tokenHash: "irrelevant-in-mock",
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    };
    mockTransaction(tokenRow);

    await expect(resetPassword({ token: "raw-token", password: "newpassword123" })).rejects.toThrow(
      "This reset link is invalid or has expired",
    );
  });

  it("rejects an already-used (consumed) token", async () => {
    const tokenRow: FakeTokenRow = {
      id: "token-1",
      userId: "user-1",
      tokenHash: "irrelevant-in-mock",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      consumedAt: new Date(),
    };
    mockTransaction(tokenRow);

    await expect(resetPassword({ token: "raw-token", password: "newpassword123" })).rejects.toThrow(
      "This reset link is invalid or has expired",
    );
  });

  it("rejects an unknown token", async () => {
    mockTransaction(null);

    await expect(resetPassword({ token: "bogus-token", password: "newpassword123" })).rejects.toThrow(
      "This reset link is invalid or has expired",
    );
  });
});
