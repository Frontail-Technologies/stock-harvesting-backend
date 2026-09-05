import { HTTP_STATUS } from "../constants";
import { ERROR_CODES, type ApiErrorCode } from "./codes";
import { ERROR_MESSAGES } from "./messages";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function badRequest(message: string = ERROR_MESSAGES.badRequest, details?: unknown) {
  return new AppError(HTTP_STATUS.badRequest, ERROR_CODES.badRequest, message, details);
}

export function unauthorized(message: string = ERROR_MESSAGES.authRequired) {
  return new AppError(HTTP_STATUS.unauthorized, ERROR_CODES.unauthorized, message);
}

export function forbidden(message: string = ERROR_MESSAGES.adminRequired) {
  return new AppError(HTTP_STATUS.forbidden, ERROR_CODES.forbidden, message);
}

export function notFound(message: string = ERROR_MESSAGES.notFound) {
  return new AppError(HTTP_STATUS.notFound, ERROR_CODES.notFound, message);
}

export function conflict(message: string = ERROR_MESSAGES.conflict, details?: unknown) {
  return new AppError(HTTP_STATUS.conflict, ERROR_CODES.conflict, message, details);
}

export function rateLimited(message: string = ERROR_MESSAGES.rateLimited, details?: unknown) {
  return new AppError(HTTP_STATUS.tooManyRequests, ERROR_CODES.rateLimited, message, details);
}

// A data-provider/vendor call failed - status and code now agree (both mean
// "upstream", not "the client's request was malformed"). `details` should
// stay client-safe (see error-handler.ts, which serializes it directly to
// the response) - callers needing to retain raw vendor error text for their
// own logs should log it themselves before calling this, not pass it here.
export function providerError(
  message: string = ERROR_MESSAGES.providerRequestFailed,
  details?: unknown
) {
  return new AppError(HTTP_STATUS.badGateway, ERROR_CODES.providerError, message, details);
}
