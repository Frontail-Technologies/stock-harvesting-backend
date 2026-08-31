import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";

import { USER_ROLE } from "../../shared/constants";
import { signAccessToken } from "../security/tokens";
import { requireAdmin, requireAdminAuth, requireAuth, requireRole } from "./auth.middleware";

// The admin subdomain (src/proxy.ts, verified separately) is routing/UX
// only - the actual authorization boundary is this middleware, applied to
// every /api/admin/* route regardless of which host the request came from.
// These exercise it directly (fake req/res/next, no HTTP server needed),
// covering the "accepted" / "rejected" cases from the plan's validation
// list for the admin feature, which otherwise had no code changes to test.
function fakeReq(role?: (typeof USER_ROLE)[keyof typeof USER_ROLE]): Request {
  return {
    user: role ? { id: "user-1", email: "user@example.com", role, plan: "free" } : undefined,
  } as unknown as Request;
}

const noopRes = {} as Response;

describe("requireAdmin", () => {
  it("accepts a request from an admin user", () => {
    const req = fakeReq(USER_ROLE.admin);
    let called = false;
    const next: NextFunction = () => {
      called = true;
    };

    expect(() => requireAdmin(req, noopRes, next)).not.toThrow();
    expect(called).toBe(true);
  });

  it("rejects a request from a non-admin user", () => {
    const req = fakeReq(USER_ROLE.user);
    const next: NextFunction = () => {
      throw new Error("next() should not be called");
    };

    expect(() => requireAdmin(req, noopRes, next)).toThrow();
  });

  it("rejects a request with no authenticated user", () => {
    const req = fakeReq();
    const next: NextFunction = () => {
      throw new Error("next() should not be called");
    };

    expect(() => requireAdmin(req, noopRes, next)).toThrow();
  });
});

function fakeReqWithBearer(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

const USER_TOKEN_PAYLOAD = {
  sub: "user-1",
  email: "user@example.com",
  role: "user" as const,
  plan: "free" as const,
  portal: "user" as const,
};
const ADMIN_TOKEN_PAYLOAD = {
  sub: "admin-1",
  email: "admin@example.com",
  role: "admin" as const,
  plan: "free" as const,
  portal: "admin" as const,
};

// Strict portal separation (item 8/13/14, test matrix E/F/G/H) - the
// actual enforcement point every /api/* route runs through. Unlike
// requireAdmin above (which only ever sees a plain fake req.user object),
// these sign and verify REAL tokens, exercising the same aud-claim check
// production requests go through.
describe("requireAuth (USER portal)", () => {
  it("accepts a real USER-portal token", () => {
    const req = fakeReqWithBearer(signAccessToken(USER_TOKEN_PAYLOAD, 900));
    let called = false;
    requireAuth(req, noopRes, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.user).toMatchObject({ id: "user-1", role: "user" });
  });

  it("F: rejects an ADMIN-portal token, even one belonging to an admin-role account", () => {
    const req = fakeReqWithBearer(signAccessToken(ADMIN_TOKEN_PAYLOAD, 600));
    expect(() =>
      requireAuth(req, noopRes, () => {
        throw new Error("next() should not be called");
      })
    ).toThrow();
  });

  it("rejects a request with no Authorization header", () => {
    const req = { headers: {} } as unknown as Request;
    expect(() =>
      requireAuth(req, noopRes, () => {
        throw new Error("next() should not be called");
      })
    ).toThrow();
  });
});

describe("requireAdminAuth (ADMIN portal)", () => {
  it("accepts a real ADMIN-portal token", () => {
    const req = fakeReqWithBearer(signAccessToken(ADMIN_TOKEN_PAYLOAD, 600));
    let called = false;
    requireAdminAuth(req, noopRes, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.user).toMatchObject({ id: "admin-1", role: "admin" });
  });

  it("E: rejects a USER-portal token", () => {
    const req = fakeReqWithBearer(signAccessToken(USER_TOKEN_PAYLOAD, 900));
    expect(() =>
      requireAdminAuth(req, noopRes, () => {
        throw new Error("next() should not be called");
      })
    ).toThrow();
  });
});

describe("requireRole", () => {
  it("accepts any role included in the allowed list", () => {
    const middleware = requireRole(USER_ROLE.user, USER_ROLE.admin);
    let called = false;
    const next: NextFunction = () => {
      called = true;
    };

    expect(() => middleware(fakeReq(USER_ROLE.user), noopRes, next)).not.toThrow();
    expect(called).toBe(true);
  });

  it("rejects a role not included in the allowed list", () => {
    const middleware = requireRole(USER_ROLE.admin);
    const next: NextFunction = () => {
      throw new Error("next() should not be called");
    };

    expect(() => middleware(fakeReq(USER_ROLE.user), noopRes, next)).toThrow();
  });
});
