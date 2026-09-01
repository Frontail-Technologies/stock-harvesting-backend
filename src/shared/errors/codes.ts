export const ERROR_CODES = {
  badRequest: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  validationError: "VALIDATION_ERROR",
  internalError: "INTERNAL_ERROR",
  // A vendor/upstream data-provider call failed (non-2xx response, timeout,
  // or unusable payload) - distinct from badRequest, which means the
  // caller's own request was malformed. Always paired with
  // HTTP_STATUS.badGateway; see providerError() below.
  providerError: "PROVIDER_ERROR",
} as const;

export type ApiErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
