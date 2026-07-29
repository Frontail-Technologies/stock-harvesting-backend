import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { HTTP_STATUS } from "../constants";
import { AppError } from "./app-error";
import { ERROR_CODES } from "./codes";
import { ERROR_MESSAGES } from "./messages";
import { logger } from "../logger";

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (error instanceof AppError) {
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
