import type { Request, Response } from "express";

import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MINUTES,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_DAYS,
} from "../../shared/constants";
import { env } from "../../shared/env";

function secureCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
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
