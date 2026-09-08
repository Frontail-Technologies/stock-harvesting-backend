import { describe, expect, it } from "vitest";

import { resolveAuthPortal, resolveOauthDestination } from "./google-auth.service";
import { evaluatePortalAccess } from "./session.service";

// Covers the one place deciding which frontend origin a Google login bounces back to - a regression here could strand admin logins on the main site or force every deployment to configure ADMIN_WEB_APP_URL.
describe("resolveOauthDestination", () => {
  const config = { webAppUrl: "https://stockharvesting.com" };
  const configWithAdmin = {
    webAppUrl: "https://stockharvesting.com",
    adminWebAppUrl: "https://admin.stockharvesting.com",
  };

  it("main-site login (no portal hint) always lands on the main origin's /dashboard", () => {
    expect(resolveOauthDestination(undefined, config)).toEqual({
      origin: "https://stockharvesting.com",
      successPath: "/dashboard",
    });
    expect(resolveOauthDestination(undefined, configWithAdmin)).toEqual({
      origin: "https://stockharvesting.com",
      successPath: "/dashboard",
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
      successPath: "/dashboard",
    });
  });
});

// Strict portal separation - resolveAuthPortal maps the OAuth portal cookie to the AuthPortal type; only an exact "admin" value resolves to admin, everything else falls back to the least-privileged "user" portal.
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

// Strict portal separation - login-time enforcement (items 2-5, matrix B/D): an admin account must never get a USER session, a non-admin must never get an ADMIN session; evaluatePortalAccess is the pure decision tested here without a real OAuth/DB round-trip.
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
