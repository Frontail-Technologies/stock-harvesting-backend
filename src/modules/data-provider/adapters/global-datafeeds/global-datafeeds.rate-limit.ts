import { ProviderRateLimitedError } from "../../../../shared/errors/provider-rate-limited-error";
import type { GlobalDatafeedsResponse } from "./global-datafeeds.types";

export const GDF_RATE_LIMIT_BASE_COOLDOWN_MS = 5 * 60_000;
export const GDF_RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 60_000;
export const GDF_RATE_LIMIT_REDIS_KEY = "gdf:rate-limit:blocked-until";
const HOUR_MS = 60 * 60_000;

// GDF answers a call over the hourly quota with a RequestError ("Calls per hour are limited.") that
// carries no request tag, so it can never be matched to the request that caused it and every affected
// request just waited out its timeout.
export function isGdfRateLimitMessage(response: GlobalDatafeedsResponse) {
  return response.MessageType === "RequestError" && /calls per hour are limited/i.test(response.Message ?? "");
}

// Stops a process from sending calls the provider will refuse: it blocks all calls for a cooldown after
// a rate-limit reply (growing while it keeps happening), and can optionally cap calls per rolling hour
// on the client side so the quota is never exceeded in the first place.
export class GdfCallGate {
  private blockedUntil = 0;
  private hits = 0;
  private calls: number[] = [];
  private nextCallAt = 0;

  constructor(private readonly maxCallsPerHour = 0) {}

  assertAllowed(now = Date.now()) {
    if (now < this.blockedUntil) throw new ProviderRateLimitedError("Global Datafeeds", this.blockedUntil - now);
  }

  // Reserve evenly spaced send slots instead of allowing the whole hourly
  // allowance to burst immediately and then blocking the worker for an hour.
  reserveDelayMs(now = Date.now()) {
    if (this.maxCallsPerHour <= 0) return 0;
    const intervalMs = Math.ceil(HOUR_MS / this.maxCallsPerHour);
    const sendAt = Math.max(now, this.nextCallAt);
    this.nextCallAt = sendAt + intervalMs;
    return sendAt - now;
  }

  // Counts one call toward the hourly cap; throws when the cap is already reached.
  registerCall(now = Date.now()) {
    if (this.maxCallsPerHour <= 0) return;
    this.calls = this.calls.filter((time) => now - time < HOUR_MS);
    if (this.calls.length >= this.maxCallsPerHour) {
      throw new ProviderRateLimitedError("Global Datafeeds", this.calls[0] + HOUR_MS - now);
    }
    this.calls.push(now);
  }

  // Returns the error to fail waiting requests with. Replies arrive once per refused call, so a reply
  // during an active block does not lengthen the block again.
  onRateLimited(now = Date.now()) {
    if (now < this.blockedUntil) return new ProviderRateLimitedError("Global Datafeeds", this.blockedUntil - now);
    this.hits += 1;
    const cooldown = Math.min(GDF_RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** (this.hits - 1), GDF_RATE_LIMIT_MAX_COOLDOWN_MS);
    this.blockedUntil = now + cooldown;
    return new ProviderRateLimitedError("Global Datafeeds", cooldown);
  }

  onSuccess() {
    this.hits = 0;
  }
}
