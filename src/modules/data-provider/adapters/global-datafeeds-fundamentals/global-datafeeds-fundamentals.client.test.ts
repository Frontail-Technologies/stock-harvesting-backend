import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../../../shared/errors";
import { env } from "../../../../shared/env";
import {
  fetchSectoralClassificationBySector,
  fetchSectors,
} from "./global-datafeeds-fundamentals.client";

// Regression coverage for the Fundamentals client's two bounded retry paths:
//
//  - Transport: a raw `TypeError: fetch failed` / `SocketError: other side
//    closed` (the Kestrel host dropping the TCP connection) must normalize to
//    PROVIDER_ERROR 502 with a credential-free message; a transient socket
//    error gets a small bounded retry; a real 4xx like "Key Expired" is
//    returned as-is and never retried.
//  - Auth handshake: an HTTP 408 whose body is exactly "Authentication
//    request received. Try request data in next moment." is the provider
//    asking us to reissue the same request; retried up to twice with a short
//    delay, then a deterministic PROVIDER_ERROR. An unrelated 408 is not.
//
// Total HTTP attempts are additively bounded (1 + 2 network + 2 handshake = 5).

const ACCESS_KEY = "test-fundamentals-access-key-1234567";

const originalEnabled = env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ENABLED;
const originalKey = env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ACCESS_KEY;
const originalBaseUrl = env.GLOBAL_DATAFEEDS_FUNDAMENTALS_BASE_URL;

let fetchMock: ReturnType<typeof vi.fn>;

function socketClosedError() {
  // Shape undici produces for "other side closed".
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function causeCodeError(code: string, message = "fetch failed") {
  const cause = Object.assign(new Error(code), { code });
  return Object.assign(new TypeError(message), { cause });
}

function okJson(value: unknown) {
  return { ok: true, status: 200, json: async () => ({ Value: value }) } as unknown as Response;
}

function httpError(status: number, body: string) {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

const HANDSHAKE_BODY =
  "Authentication request received. Try request data in next moment.";

function handshake408() {
  return { ok: false, status: 408, text: async () => HANDSHAKE_BODY } as unknown as Response;
}

beforeEach(() => {
  env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ENABLED = true;
  env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ACCESS_KEY = ACCESS_KEY;
  env.GLOBAL_DATAFEEDS_FUNDAMENTALS_BASE_URL = "https://fundamentals.example.test:4532";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ENABLED = originalEnabled;
  env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ACCESS_KEY = originalKey;
  env.GLOBAL_DATAFEEDS_FUNDAMENTALS_BASE_URL = originalBaseUrl;
});

// Pumps the bounded-retry backoff timers to completion and reports the
// outcome. Fulfil + reject handlers are attached synchronously so a retried
// rejection is never briefly "unhandled" while the fake timers advance.
async function run<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return outcome;
}

describe("global-datafeeds-fundamentals client - transport error normalization", () => {
  it("maps a socket-closed transport error to PROVIDER_ERROR 502 (not an unhandled 500)", async () => {
    fetchMock.mockRejectedValue(socketClosedError());

    const { error } = await run(fetchSectors());

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(502);
    expect((error as AppError).code).toBe(ERROR_CODES.providerError);
  });

  it("gives a transient socket error a small bounded retry (3 attempts total)", async () => {
    fetchMock.mockRejectedValue(socketClosedError());

    await run(fetchSectors());

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("succeeds without further retry once a retried attempt returns data", async () => {
    fetchMock
      .mockRejectedValueOnce(causeCodeError("ECONNRESET"))
      .mockResolvedValueOnce(okJson([{ Code: "10", Name: "Information Technology" }]));

    const { value } = await run(fetchSectors());

    expect(value).toEqual([{ code: "10", name: "Information Technology" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-transient transport error (ECONNREFUSED)", async () => {
    fetchMock.mockRejectedValue(causeCodeError("ECONNREFUSED"));

    const { error } = await run(fetchSectors());

    expect((error as AppError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes an AbortError/timeout to PROVIDER_ERROR 502", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    );

    const { error } = await run(fetchSectoralClassificationBySector("Energy"));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(502);
    expect((error as AppError).code).toBe(ERROR_CODES.providerError);
  });

  it("returns a provider 4xx (e.g. Key Expired) as-is, with no retry", async () => {
    fetchMock.mockResolvedValue(httpError(400, "Key Expired"));

    const { error } = await run(fetchSectors());

    expect((error as AppError).status).toBe(502);
    expect((error as AppError).code).toBe(ERROR_CODES.providerError);
    expect((error as AppError).message).toContain("400");
    expect((error as AppError).message).toContain("Key Expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a non-JSON 200 body to PROVIDER_ERROR 502", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token A in JSON at position 0");
      },
    } as unknown as Response);

    const { error } = await run(fetchSectors());

    expect((error as AppError).status).toBe(502);
    expect((error as AppError).code).toBe(ERROR_CODES.providerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never leaks the access key or the credentialed URL in the error", async () => {
    fetchMock.mockRejectedValue(socketClosedError());

    const { error } = await run(fetchSectors());
    const appError = error as AppError;

    const serialized = `${appError.message} ${JSON.stringify(appError.details ?? {})}`;
    expect(serialized).not.toContain(ACCESS_KEY);
    expect(serialized).not.toContain("accessKey=");
    expect(appError.details).toEqual({
      provider: "global-datafeeds-fundamentals",
      reason: "network",
    });
  });

  it("passes a healthy response straight through", async () => {
    fetchMock.mockResolvedValue(
      okJson([
        { Code: "1", Name: "Energy" },
        { Code: "2", Name: "Financials" },
      ])
    );

    const sectors = await fetchSectors();

    expect(sectors).toEqual([
      { code: "1", name: "Energy" },
      { code: "2", name: "Financials" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("global-datafeeds-fundamentals client - auth handshake retry", () => {
  it("retries the same request after a first handshake 408 and returns the eventual data", async () => {
    fetchMock
      .mockResolvedValueOnce(handshake408())
      .mockResolvedValueOnce(okJson([{ Code: "5", Name: "Healthcare" }]));

    const { value } = await run(fetchSectors());

    expect(value).toEqual([{ code: "5", name: "Healthcare" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tolerates two consecutive handshake responses and still succeeds within the bound", async () => {
    fetchMock
      .mockResolvedValueOnce(handshake408())
      .mockResolvedValueOnce(handshake408())
      .mockResolvedValueOnce(okJson([{ Code: "7", Name: "Utilities" }]));

    const { value } = await run(fetchSectoralClassificationBySector("Utilities"));

    expect(value).toEqual([{ Code: "7", Name: "Utilities" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails deterministically with PROVIDER_ERROR after the max handshake retries (3 attempts)", async () => {
    fetchMock.mockResolvedValue(handshake408());

    const { error } = await run(fetchSectors());
    const appError = error as AppError;

    expect(appError).toBeInstanceOf(AppError);
    expect(appError.status).toBe(502);
    expect(appError.code).toBe(ERROR_CODES.providerError);
    expect(appError.details).toEqual({
      provider: "global-datafeeds-fundamentals",
      status: 408,
      reason: "auth-handshake",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const serialized = `${appError.message} ${JSON.stringify(appError.details ?? {})}`;
    expect(serialized).not.toContain(ACCESS_KEY);
    expect(serialized).not.toContain("accessKey=");
  });

  it("does NOT retry an unrelated 408 (no handshake body) - exactly 1 attempt", async () => {
    fetchMock.mockResolvedValue(httpError(408, "Gateway timed out waiting for upstream"));

    const { error } = await run(fetchSectors());
    const appError = error as AppError;

    expect(appError.status).toBe(502);
    expect(appError.code).toBe(ERROR_CODES.providerError);
    expect(appError.message).toContain("408");
    expect(appError.details).toEqual({
      provider: "global-datafeeds-fundamentals",
      status: 408,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps transport and handshake retries additive - total attempts never exceed 5", async () => {
    fetchMock
      .mockRejectedValueOnce(socketClosedError())
      .mockRejectedValueOnce(socketClosedError())
      .mockResolvedValueOnce(handshake408())
      .mockResolvedValueOnce(handshake408())
      .mockResolvedValueOnce(handshake408())
      .mockResolvedValue(okJson([{ Code: "9", Name: "Unreached" }]));

    const { error } = await run(fetchSectors());

    expect((error as AppError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
