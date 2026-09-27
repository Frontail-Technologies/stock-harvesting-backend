import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queues", () => ({ getMarketDataQueueRedisClient: vi.fn() }));

import * as queuesModule from "./queues";
import { assertGlobalDatafeedsAvailable, getGlobalDatafeedsCooldown } from "./provider-cooldown.service";

const getMarketDataQueueRedisClient = vi.mocked(queuesModule.getMarketDataQueueRedisClient);
const NOW = new Date("2026-09-27T06:30:00.000Z");

describe("Global Datafeeds shared cooldown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the provider cooldown stored by the session owner", async () => {
    const blockedUntil = NOW.getTime() + 51 * 60_000;
    getMarketDataQueueRedisClient.mockResolvedValue({ get: vi.fn(async () => String(blockedUntil)) } as never);

    await expect(getGlobalDatafeedsCooldown(NOW)).resolves.toEqual({
      active: true,
      until: new Date(blockedUntil).toISOString(),
      remainingMs: 51 * 60_000,
    });
  });

  it("treats an expired key as available", async () => {
    getMarketDataQueueRedisClient.mockResolvedValue({ get: vi.fn(async () => String(NOW.getTime() - 1)) } as never);

    await expect(getGlobalDatafeedsCooldown(NOW)).resolves.toEqual({ active: false, until: null, remainingMs: 0 });
  });

  it("rejects a provider action during the shared cooldown", async () => {
    getMarketDataQueueRedisClient.mockResolvedValue({
      get: vi.fn(async () => String(Date.now() + 10 * 60_000)),
    } as never);

    await expect(assertGlobalDatafeedsAvailable()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
  });
});
