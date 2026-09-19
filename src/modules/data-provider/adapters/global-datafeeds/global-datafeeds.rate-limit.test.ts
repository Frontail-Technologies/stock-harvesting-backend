import { describe, expect, it } from "vitest";

import { ProviderRateLimitedError } from "../../../../shared/errors";
import {
  GDF_RATE_LIMIT_BASE_COOLDOWN_MS,
  GDF_RATE_LIMIT_MAX_COOLDOWN_MS,
  GdfCallGate,
  isGdfRateLimitMessage,
} from "./global-datafeeds.rate-limit";

const T = 1_000_000;
const MIN = 60_000;

describe("isGdfRateLimitMessage", () => {
  it("recognises GDF's hourly quota reply", () => {
    expect(isGdfRateLimitMessage({ MessageType: "RequestError", Message: "Calls per hour are limited." } as never)).toBe(true);
    expect(isGdfRateLimitMessage({ MessageType: "RequestError", Message: "calls per hour are limited" } as never)).toBe(true);
  });

  it("does not treat other errors as rate limits", () => {
    expect(isGdfRateLimitMessage({ MessageType: "RequestError", Message: "Access Denied. Key already in use by other session." } as never)).toBe(false);
    expect(isGdfRateLimitMessage({ MessageType: "HistoryResult", Message: "Calls per hour are limited." } as never)).toBe(false);
  });
});

describe("GdfCallGate after a rate-limit reply", () => {
  it("blocks calls immediately for the cooldown, then allows them again", () => {
    const gate = new GdfCallGate();
    const error = gate.onRateLimited(T);

    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect(error.retryAfterMs).toBe(GDF_RATE_LIMIT_BASE_COOLDOWN_MS);
    expect(() => gate.assertAllowed(T + MIN)).toThrow(ProviderRateLimitedError);
    expect(() => gate.assertAllowed(T + GDF_RATE_LIMIT_BASE_COOLDOWN_MS)).not.toThrow();
  });

  it("reports how much of the cooldown is left", () => {
    const gate = new GdfCallGate();
    gate.onRateLimited(T);

    expect(() => gate.assertAllowed(T + 4 * MIN)).toThrow(/retry in 1 minute/);
  });

  it("does not lengthen the block for the burst of replies GDF sends for one refused batch", () => {
    const gate = new GdfCallGate();
    gate.onRateLimited(T);
    gate.onRateLimited(T + 1_000);
    gate.onRateLimited(T + 2_000);

    expect(() => gate.assertAllowed(T + GDF_RATE_LIMIT_BASE_COOLDOWN_MS)).not.toThrow();
  });

  it("doubles the cooldown when it is hit again after the block, up to the maximum", () => {
    const gate = new GdfCallGate();
    let now = T;
    const cooldowns: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      cooldowns.push(gate.onRateLimited(now).retryAfterMs);
      now += GDF_RATE_LIMIT_MAX_COOLDOWN_MS + MIN;
    }

    expect(cooldowns).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 30 * MIN, 30 * MIN]);
  });

  it("resets the escalation after a successful call", () => {
    const gate = new GdfCallGate();
    gate.onRateLimited(T);
    gate.onSuccess();

    expect(gate.onRateLimited(T + 10 * MIN).retryAfterMs).toBe(GDF_RATE_LIMIT_BASE_COOLDOWN_MS);
  });
});

describe("GdfCallGate hourly cap", () => {
  it("is off when the cap is 0", () => {
    const gate = new GdfCallGate(0);
    for (let index = 0; index < 5_000; index += 1) gate.registerCall(T);
    expect(() => gate.registerCall(T)).not.toThrow();
  });

  it("refuses calls beyond the cap within a rolling hour", () => {
    const gate = new GdfCallGate(3);
    gate.registerCall(T);
    gate.registerCall(T + MIN);
    gate.registerCall(T + 2 * MIN);

    expect(() => gate.registerCall(T + 3 * MIN)).toThrow(ProviderRateLimitedError);
  });

  it("says when the oldest call leaves the window", () => {
    const gate = new GdfCallGate(1);
    gate.registerCall(T);

    try {
      gate.registerCall(T + 10 * MIN);
      throw new Error("expected a rate-limit error");
    } catch (error) {
      expect((error as ProviderRateLimitedError).retryAfterMs).toBe(50 * MIN);
    }
  });

  it("allows calls again once the oldest ones are older than an hour", () => {
    const gate = new GdfCallGate(2);
    gate.registerCall(T);
    gate.registerCall(T + MIN);

    expect(() => gate.registerCall(T + 61 * MIN)).not.toThrow();
  });
});
