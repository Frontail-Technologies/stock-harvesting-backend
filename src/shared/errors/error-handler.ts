import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { HTTP_STATUS } from "../constants";
import { AppError } from "./app-error";
import { ERROR_CODES, type ApiErrorCode } from "./codes";
import { ERROR_MESSAGES } from "./messages";
import { logger } from "../logger";

// Expected client/auth validation failures - the caller did something the
// API already documents as rejectable (bad input, no/expired session, no
// permission, unknown resource). Worth a low-noise trace, not a warning -
// these happen constantly in normal operation (an expired token, a typo'd
// URL) and pino-http's own access log already records the status code.
const LOW_NOISE_ERROR_CODES = new Set<ApiErrorCode>([
  ERROR_CODES.badRequest,
  ERROR_CODES.unauthorized,
  ERROR_CODES.forbidden,
  ERROR_CODES.notFound,
  ERROR_CODES.validationError,
]);

function logAppError(error: AppError, req: Request) {
  const context = { reqId: req.id, code: error.code, status: error.status, path: req.path };

  if (error.code === ERROR_CODES.providerError) {
    logger.warn(context, error.message);
    return;
  }
  if (error.code === ERROR_CODES.internalError) {
    logger.error(context, error.message);
    return;
  }
  if (LOW_NOISE_ERROR_CODES.has(error.code)) {
    logger.debug(context, error.message);
    return;
  }
  // Everything else (conflict and any future domain-specific code) -
  // unexpected enough to be worth a trace above debug, not alarming enough
  // for warn.
  logger.info(context, error.message);
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (error instanceof AppError) {
    logAppError(error, req);
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  if (error instanceof ZodError) {
    return res.status(HTTP_STATUS.badRequest).json({
      error: {
        code: ERROR_CODES.validationError,
        message: ERROR_MESSAGES.invalidRequestData,
        details: error.issues,
      },
    });
  }

  logger.error(
    {
      err: error,
      reqId: req.id,
      method: req.method,
      path: req.path,
    },
    "Unhandled request error"
  );

  return res.status(HTTP_STATUS.internalServerError).json({
    error: {
      code: ERROR_CODES.internalError,
      message: ERROR_MESSAGES.generic,
    },
  });
}
