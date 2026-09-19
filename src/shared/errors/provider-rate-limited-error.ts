import { AppError } from "./app-error";
import { ERROR_CODES } from "./codes";
import { HTTP_STATUS } from "../constants";

// A data provider refused calls because the account's quota is used up (for GlobalDataFeeds:
// "Calls per hour are limited"). Callers stop work and retry after `retryAfterMs` instead of
// counting every remaining call as an individual failure.
export class ProviderRateLimitedError extends AppError {
  constructor(
    public readonly provider: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      HTTP_STATUS.tooManyRequests,
      ERROR_CODES.rateLimited,
      `${provider} call limit reached; retry in ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} minute(s)`,
    );
    this.name = "ProviderRateLimitedError";
  }
}

export function isProviderRateLimitedError(error: unknown): error is ProviderRateLimitedError {
  return error instanceof ProviderRateLimitedError;
}
