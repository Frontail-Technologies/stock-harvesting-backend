import { describe, expect, it } from "vitest";

import { evaluatePortalAccess, resolveAuthPortal, resolveOauthDestination } from "./auth.service";

// Covers the one place that decides which frontend origin a Google login
// bounces back to (auth.routes.ts's callback handler) - a regression here
// would either strand admin logins on the main site (defeating portal
// separation) or, worse, require every deployment to configure
// ADMIN_WEB_APP_URL just to keep the existing main-site login working.
describe("resolveOauthDestination", () => {
  const config = { webAppUrl: "https://stockharvesting.com" };
  const configWithAdmin = {
    webAppUrl: "https://stockharvesting.com",
    adminWebAppUrl: "https://admin.stockharvesting.com",
  };

  it("main-site login (no portal hint) always lands on the main origin's /charts", () => {
    expect(resolveOauthDestination(undefined, config)).toEqual({
      origin: "https://stockharvesting.com",
      successPath: "/charts",
    });
    expect(resolveOauthDestination(undefined, configWithAdmin)).toEqual({
      origin: "https://stockharvesting.com",
      successPath: "/charts",
    });
  });

  it("admin-portal login lands back on the admin origin's own /login, never /charts or /admin", () => {
    expect(resolveOauthDestination("admin", configWithAdmin)).toEqual({
      origin: "https://admin.stockharvesting.com",
      successPath: "/login",
    });
  });

  it("admin-portal login falls back to the main origin when ADMIN_WEB_APP_URL is unset - never throws or strands the user", () => {
    expect(resolveOauthDestination("admin", config)).toEqual({
      origin: "https://stockharvesting.com",
      successPath: "/login",
    });
  });

  it("an unrecognized portal value is treated as the main site, not admin", () => {
    expect(resolveOauthDestination("something-else", configWithAdmin)).toEqual({
      origin: "https://stockharvesting.com",
      successPath: "/charts",
    });
  });
});

// Strict portal separation - resolveAuthPortal maps the short-lived OAuth
// portal cookie to the AuthPortal type completeGoogleLogin/createSession/
// rotateRefreshToken all key on. Only ever "admin" for an exact "admin"
// value; everything else (missing, tampered, unrecognized) resolves to the
// least-privileged "user" portal.
describe("resolveAuthPortal", () => {
  it("maps the exact 'admin' cookie value to the admin portal", () => {
    expect(resolveAuthPortal("admin")).toBe("admin");
  });

  it("maps undefined, 'main', and any other value to the user portal", () => {
    expect(resolveAuthPortal(undefined)).toBe("user");
    expect(resolveAuthPortal("main")).toBe("user");
    expect(resolveAuthPortal("Admin")).toBe("user");
    expect(resolveAuthPortal("admin ")).toBe("user");
    expect(resolveAuthPortal("")).toBe("user");
  });
});

// Strict portal separation - the actual login-time enforcement (items 2-5,
// test matrix B/D): an admin-role account must never be granted a USER
// portal session, and a non-admin account must never be granted an ADMIN
// portal session. evaluatePortalAccess is the pure decision at the heart
// of completeGoogleLogin, tested here without any real OAuth/DB round-trip.
describe("evaluatePortalAccess", () => {
  it("A: a normal user logging into the USER portal is allowed", () => {
    expect(evaluatePortalAccess("user", "user")).toEqual({ allowed: true });
  });

  it("B: an admin account logging into the USER portal is rejected, not silently downgraded", () => {
    expect(evaluatePortalAccess("admin", "user")).toEqual({
      allowed: false,
      reason: "admin-account-on-user-portal",
    });
  });

  it("C: an admin account logging into the ADMIN portal is allowed", () => {
    expect(evaluatePortalAccess("admin", "admin")).toEqual({ allowed: true });
  });

  it("D: a normal user logging into the ADMIN portal is rejected", () => {
    expect(evaluatePortalAccess("user", "admin")).toEqual({
      allowed: false,
      reason: "not-admin-on-admin-portal",
    });
  });
});
