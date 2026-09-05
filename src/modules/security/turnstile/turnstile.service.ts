import type { NextFunction, Request, Response as ExpressResponse } from "express";

import { HTTP_STATUS } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { AppError, ERROR_CODES, ERROR_MESSAGES } from "../../../shared/errors";
import { logger } from "../../../shared/logger";

const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TOKEN_HEADER = "x-turnstile-token";

type TurnstileSiteverifyResponse = {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  "error-codes"?: string[];
};

type VerifyTurnstileOptions = {
  token: string | undefined;
  remoteIp?: string;
  expectedAction?: string;
};

function isTurnstileConfigured() {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

function shouldBypassTurnstileForLocalDev() {
  return env.NODE_ENV !== "production" && !isTurnstileConfigured();
}

function turnstileError(details?: unknown) {
  return new AppError(
    HTTP_STATUS.badRequest,
    ERROR_CODES.botVerificationFailed,
    ERROR_MESSAGES.botVerificationFailed,
    details
  );
}

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

function getAllowedProductionHostnames() {
  const hosts = new Set(["stockharvesting.com", "admin.stockharvesting.com"]);
  try {
    hosts.add(normalizeHostname(new URL(env.WEB_APP_URL).hostname));
  } catch {}
  if (env.ADMIN_WEB_APP_URL) {
    try {
      hosts.add(normalizeHostname(new URL(env.ADMIN_WEB_APP_URL).hostname));
    } catch {}
  }
  return hosts;
}

export async function verifyTurnstileToken({
  token,
  remoteIp,
  expectedAction,
}: VerifyTurnstileOptions) {
  if (shouldBypassTurnstileForLocalDev()) {
    logger.warn("Turnstile skipped because TURNSTILE_SECRET_KEY is not configured outside production");
    return;
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      "Turnstile is not configured"
    );
  }

  if (!token) {
    throw turnstileError({ reason: "missing-token" });
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });

  if (remoteIp) body.set("remoteip", remoteIp);

  let response: globalThis.Response;
  try {
    response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (error) {
    logger.warn(
      { message: error instanceof Error ? error.message : "Unknown Turnstile error" },
      "Turnstile siteverify request failed"
    );
    throw turnstileError({ reason: "siteverify-unreachable" });
  }

  let payload: TurnstileSiteverifyResponse;
  try {
    payload = (await response.json()) as TurnstileSiteverifyResponse;
  } catch {
    throw turnstileError({ reason: "invalid-siteverify-response" });
  }

  if (!response.ok || !payload.success) {
    throw turnstileError({
      reason: "siteverify-rejected",
      errorCodes: payload["error-codes"] ?? [],
    });
  }

  if (expectedAction && payload.action !== expectedAction) {
    throw turnstileError({ reason: "action-mismatch" });
  }

  if (env.NODE_ENV === "production") {
    if (!payload.hostname || !getAllowedProductionHostnames().has(normalizeHostname(payload.hostname))) {
      throw turnstileError({ reason: "hostname-mismatch" });
    }
  }
}

function readTurnstileToken(req: Request) {
  const headerValue = req.header(TURNSTILE_TOKEN_HEADER);
  if (headerValue) return headerValue;

  const body = req.body as { turnstileToken?: unknown } | undefined;
  return typeof body?.turnstileToken === "string" ? body.turnstileToken : undefined;
}

export function requireTurnstile(expectedAction: string | ((req: Request) => string)) {
  return async (req: Request, _res: ExpressResponse, next: NextFunction) => {
    try {
      await verifyTurnstileToken({
        token: readTurnstileToken(req),
        remoteIp: req.ip,
        expectedAction: typeof expectedAction === "function" ? expectedAction(req) : expectedAction,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
