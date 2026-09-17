import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rateLimit } from "./rate-limit";

function fakeReqRes(ip: string, body: Record<string, unknown> = {}) {
  const req = { ip, socket: { remoteAddress: ip }, body } as unknown as Parameters<
    ReturnType<typeof rateLimit>
  >[0];
  const res = {} as Parameters<ReturnType<typeof rateLimit>>[1];
  return { req, res };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("allows requests under the max within the window", () => {
    const middleware = rateLimit({ keyPrefix: "test:under", windowMs: 60_000, max: 3 });
    const { req, res } = fakeReqRes("1.1.1.1");
    const next = vi.fn();

    middleware(req, res, next);
    middleware(req, res, next);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(3);
    for (const call of next.mock.calls) {
      expect(call[0]).toBeUndefined();
    }
  });

  it("blocks once the max is exceeded within the window", () => {
    const middleware = rateLimit({ keyPrefix: "test:over", windowMs: 60_000, max: 2 });
    const { req, res } = fakeReqRes("2.2.2.2");
    const next = vi.fn();

    middleware(req, res, next);
    middleware(req, res, next);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
    expect(next.mock.calls[2][0]).toBeInstanceOf(Error);
  });

  it("resets the count once the window has passed", () => {
    const middleware = rateLimit({ keyPrefix: "test:reset", windowMs: 60_000, max: 1 });
    const { req, res } = fakeReqRes("3.3.3.3");
    const next = vi.fn();

    middleware(req, res, next);
    vi.advanceTimersByTime(60_001);
    middleware(req, res, next);

    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
  });

  it("keeps separate buckets per IP", () => {
    const middleware = rateLimit({ keyPrefix: "test:per-ip", windowMs: 60_000, max: 1 });
    const a = fakeReqRes("4.4.4.4");
    const b = fakeReqRes("5.5.5.5");
    const next = vi.fn();

    middleware(a.req, a.res, next);
    middleware(b.req, b.res, next);

    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
  });

  it("keeps separate buckets per email within the same IP", () => {
    const middleware = rateLimit({ keyPrefix: "test:per-email", windowMs: 60_000, max: 1 });
    const a = fakeReqRes("6.6.6.6", { email: "a@example.com" });
    const b = fakeReqRes("6.6.6.6", { email: "b@example.com" });
    const next = vi.fn();

    middleware(a.req, a.res, next);
    middleware(b.req, b.res, next);

    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
  });
});
