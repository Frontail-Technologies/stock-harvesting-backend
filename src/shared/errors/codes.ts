export const ERROR_CODES = {
  badRequest: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  validationError: "VALIDATION_ERROR",
  internalError: "INTERNAL_ERROR",
} as const;

export type ApiErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
