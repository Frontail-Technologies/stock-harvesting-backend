import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() } }));
vi.mock("../../shared/env", () => ({
  env: {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    API_BASE_URL: "http://localhost:4000",
  },
}));
vi.mock("./session.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.service")>();
  return { ...actual, createSession: vi.fn() };
});

import * as dbClientModule from "../../db/client";
import * as sessionServiceModule from "./session.service";
import { completeGoogleLogin } from "./google-auth.service";

const db = vi.mocked(dbClientModule.db);
const createSession = vi.mocked(sessionServiceModule.createSession);

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

function mockGoogleFetch(profileEmail: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "google-access-token" }),
        } as Response;
      }
      if (url.includes("openidconnect.googleapis.com")) {
        return {
          ok: true,
          json: async () => ({ sub: "google-sub-1", email: profileEmail, name: "Google User" }),
        } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  createSession.mockResolvedValue({ accessToken: "access-token", refreshToken: "refresh-token" });
});

describe("completeGoogleLogin - duplicate account prevention", () => {
  it("blocks Google login for an email that already has a password account with no prior Google link", async () => {
    mockGoogleFetch("user@example.com");
    db.select
      .mockReturnValueOnce(
        selectResult([
          { id: "user-1", email: "user@example.com", passwordHash: "hash", role: "user" },
        ]),
      ) // users lookup
      .mockReturnValueOnce(selectResult([])); // authAccounts lookup: no existing google link

    const result = await completeGoogleLogin("auth-code", "user");

    expect(result).toEqual({ ok: false, reason: "account-exists-with-password" });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows Google login for an email whose password account already has a linked Google identity", async () => {
    mockGoogleFetch("user@example.com");
    db.select
      .mockReturnValueOnce(
        selectResult([
          { id: "user-1", email: "user@example.com", name: "User", passwordHash: "hash", role: "user", plan: "free" },
        ]),
      )
      .mockReturnValueOnce(selectResult([{ id: "auth-account-1" }])); // already linked
    db.update.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve() }),
    } as never);
    db.insert.mockReturnValueOnce({
      values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
    } as never);

    const result = await completeGoogleLogin("auth-code", "user");

    expect(result.ok).toBe(true);
  });

  it("creates a brand new account when no user exists for the email yet", async () => {
    mockGoogleFetch("new@example.com");
    db.select.mockReturnValueOnce(selectResult([])); // no existing user
    db.insert
      .mockReturnValueOnce({
        values: () => ({
          returning: () =>
            Promise.resolve([
              { id: "user-new", email: "new@example.com", name: "Google User", role: "user", plan: "free" },
            ]),
        }),
      } as never)
      .mockReturnValueOnce({ values: () => Promise.resolve() } as never);

    const result = await completeGoogleLogin("auth-code", "user");

    expect(result.ok).toBe(true);
  });
});
