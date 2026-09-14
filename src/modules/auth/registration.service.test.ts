import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), transaction: vi.fn() } }));
vi.mock("./auth-email.service", () => ({ sendRegistrationOtpEmail: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { hashOtpCode } from "../security/passwords";
import { sendRegistrationOtpEmail } from "./auth-email.service";
import {
  ACCOUNT_EXISTS_WITH_GOOGLE_MESSAGE,
  ACCOUNT_EXISTS_WITH_PASSWORD_MESSAGE,
} from "./auth.constants";
import { requestUserRegistration, verifyUserRegistrationOtp } from "./registration.service";

const db = vi.mocked(dbClientModule.db);
const sendRegistrationOtpEmailMock = vi.mocked(sendRegistrationOtpEmail);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    for: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requestUserRegistration - duplicate account prevention", () => {
  it("blocks registration when a Google-only account already exists for this email", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "user-1", email: "user@example.com", passwordHash: null, role: "user" }]),
    );

    await expect(
      requestUserRegistration({ name: "New User", email: "user@example.com", password: "password123" }),
    ).rejects.toThrow(ACCOUNT_EXISTS_WITH_GOOGLE_MESSAGE);
    expect(sendRegistrationOtpEmailMock).not.toHaveBeenCalled();
  });

  it("blocks registration when a password account already exists for this email", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "user-1", email: "user@example.com", passwordHash: "hash", role: "user" }]),
    );

    await expect(
      requestUserRegistration({ name: "New User", email: "user@example.com", password: "password123" }),
    ).rejects.toThrow(ACCOUNT_EXISTS_WITH_PASSWORD_MESSAGE);
    expect(sendRegistrationOtpEmailMock).not.toHaveBeenCalled();
  });

  it("email casing/whitespace cannot bypass the duplicate check", async () => {
    db.select.mockReturnValueOnce(
      selectResult([{ id: "user-1", email: "user@example.com", passwordHash: "hash", role: "user" }]),
    );

    await expect(
      requestUserRegistration({ name: "New User", email: "  User@EXAMPLE.com  ", password: "password123" }),
    ).rejects.toThrow(ACCOUNT_EXISTS_WITH_PASSWORD_MESSAGE);
  });

  it("allows registration when no account exists for this email", async () => {
    db.select.mockReturnValueOnce(selectResult([]));
    (
      db.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>
    ) = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        insert: () => ({
          values: () => ({
            returning: () =>
              Promise.resolve([
                { id: "verification-1", expiresAt: new Date(), resendAvailableAt: new Date() },
              ]),
          }),
        }),
      };
      return cb(tx);
    }) as never;

    const result = await requestUserRegistration({
      name: "New User",
      email: "new@example.com",
      password: "password123",
    });

    expect(result.verificationId).toBe("verification-1");
    expect(sendRegistrationOtpEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("verifyUserRegistrationOtp - duplicate account prevention (defense in depth)", () => {
  function mockVerificationTransaction(existingUserRows: unknown[]) {
    (
      db.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>
    ) = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      let selectCallCount = 0;
      const tx = {
        select: () => {
          selectCallCount += 1;
          const isVerificationLookup = selectCallCount === 1;
          return {
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        id: "verification-1",
                        email: "user@example.com",
                        name: "New User",
                        passwordHash: "hash",
                        otpHash: hashOtpCode("123456"),
                        attemptCount: 0,
                        expiresAt: new Date(Date.now() + 60_000),
                        consumedAt: null,
                      },
                    ]),
                }),
                limit: () => Promise.resolve(isVerificationLookup ? [] : existingUserRows),
              }),
            }),
          };
        },
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      };
      return cb(tx);
    }) as never;
  }

  it("blocks verification if a Google account was created for this email after the request was made", async () => {
    mockVerificationTransaction([{ id: "user-1", passwordHash: null, role: "user" }]);

    await expect(
      verifyUserRegistrationOtp({ verificationId: "verification-1", code: "123456" }),
    ).rejects.toThrow(ACCOUNT_EXISTS_WITH_GOOGLE_MESSAGE);
  });

  it("blocks verification if a password account was created for this email after the request was made", async () => {
    mockVerificationTransaction([{ id: "user-1", passwordHash: "hash", role: "user" }]);

    await expect(
      verifyUserRegistrationOtp({ verificationId: "verification-1", code: "123456" }),
    ).rejects.toThrow(ACCOUNT_EXISTS_WITH_PASSWORD_MESSAGE);
  });
});
