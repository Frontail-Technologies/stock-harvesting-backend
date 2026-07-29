import { createHmac, randomBytes, timingSafeEqual } from "crypto";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  type UserPlan,
  type UserRole,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { unauthorized } from "../../shared/errors";

export type AccessTokenPayload = {
  sub: string;
  email: string;
  role: UserRole;
  plan: UserPlan;
};

type JwtPayload = AccessTokenPayload & {
  iat: number;
  exp: number;
};

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(input: string) {
  return createHmac("sha256", env.ACCESS_TOKEN_SECRET)
    .update(input)
    .digest("base64url");
}

export function signAccessToken(
  payload: AccessTokenPayload,
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS
) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const body = base64UrlJson({
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  });
  const input = `${header}.${body}`;
  return `${input}.${sign(input)}`;
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) {
    throw unauthorized("Invalid access token");
  }

  const expected = sign(`${header}.${body}`);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    throw unauthorized("Invalid access token");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JwtPayload;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw unauthorized("Access token expired");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    role: payload.role,
    plan: payload.plan,
  };
}

export function createRefreshToken() {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string) {
  return createHmac("sha256", env.REFRESH_TOKEN_SECRET)
    .update(token)
    .digest("base64url");
}

export function createOpaqueState() {
  return randomBytes(32).toString("base64url");
}
