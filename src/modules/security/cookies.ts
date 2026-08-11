import type { Request, Response } from "express";

import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MINUTES,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_DAYS,
} from "../../shared/constants";

function secureCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    // The admin subdomain is a different site from the main app, so the
    // cookie has to survive a cross-site fetch() — that requires
    // SameSite=None, which in turn requires Secure. Browsers treat
    // localhost/loopback as a trustworthy origin even over plain HTTP, so
    // this still works in local dev without HTTPS.
    secure: true,
    sameSite: "none" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(
    REFRESH_COOKIE_NAME,
    token,
    secureCookieOptions(REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  );
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
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
