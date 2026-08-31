import type { Request, Response } from "express";

import {
  ADMIN_REFRESH_COOKIE_NAME,
  OAUTH_PORTAL_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MINUTES,
  USER_REFRESH_COOKIE_NAME,
  type AuthPortal,
} from "../../shared/constants";
import { env } from "../../shared/env";

function secureCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    // The frontend origins (stockharvesting.com / admin.stockharvesting.com)
    // are different sites from this API's own origin, so the cookie has to
    // survive a cross-site fetch() — that requires SameSite=None, which in
    // turn requires Secure. Browsers treat localhost/loopback as a
    // trustworthy origin even over plain HTTP, so this still works in
    // local dev without HTTPS. No `domain` is ever set, so every auth
    // cookie stays HOST-ONLY to this API's own origin - it is never sent
    // to (or shared with) stockharvesting.com or admin.stockharvesting.com
    // directly, and critically, the user-portal and admin-portal cookies
    // never become distinguishable-only-by-domain, since both are always
    // scoped to this exact host by name alone.
    secure: true,
    sameSite: "none" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

const REFRESH_COOKIE_NAME_BY_PORTAL: Record<AuthPortal, string> = {
  user: USER_REFRESH_COOKIE_NAME,
  admin: ADMIN_REFRESH_COOKIE_NAME,
};

export function getRefreshTokenTtlMs(portal: AuthPortal): number {
  return portal === "admin"
    ? env.ADMIN_REFRESH_TOKEN_TTL_HOURS * 60 * 60 * 1000
    : env.USER_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
}

// Sets ONLY the named portal's cookie - never both. A USER-portal login
// never touches sh_admin_refresh, and an ADMIN-portal login never touches
// sh_user_refresh, so logging into one portal cannot leave the other
// portal looking authenticated on the same browser profile.
export function setRefreshCookie(res: Response, portal: AuthPortal, token: string) {
  res.cookie(
    REFRESH_COOKIE_NAME_BY_PORTAL[portal],
    token,
    secureCookieOptions(getRefreshTokenTtlMs(portal))
  );
}

export function clearRefreshCookie(res: Response, portal: AuthPortal) {
  res.clearCookie(REFRESH_COOKIE_NAME_BY_PORTAL[portal], { path: "/" });
}

export function getRefreshCookie(req: Request, portal: AuthPortal): string | undefined {
  return getCookie(req, REFRESH_COOKIE_NAME_BY_PORTAL[portal]);
}

export function setOauthStateCookie(res: Response, state: string) {
  res.cookie(
    OAUTH_STATE_COOKIE_NAME,
    state,
    secureCookieOptions(OAUTH_STATE_TTL_MINUTES * 60 * 1000)
  );
}

export function clearOauthStateCookie(res: Response) {
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
}

export function setOauthPortalCookie(res: Response, portal: string) {
  res.cookie(
    OAUTH_PORTAL_COOKIE_NAME,
    portal,
    secureCookieOptions(OAUTH_STATE_TTL_MINUTES * 60 * 1000)
  );
}

export function clearOauthPortalCookie(res: Response) {
  res.clearCookie(OAUTH_PORTAL_COOKIE_NAME, { path: "/" });
}

export function getCookie(req: Request, name: string) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .map((part) => {
      const separator = part.indexOf("=");
      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    })
    .find(([key]) => key === name)?.[1];
}
