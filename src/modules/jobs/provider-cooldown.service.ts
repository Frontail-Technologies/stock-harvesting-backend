import { GDF_RATE_LIMIT_REDIS_KEY } from "../data-provider/adapters/global-datafeeds/global-datafeeds.rate-limit";
import { ProviderRateLimitedError, getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getMarketDataQueueRedisClient } from "./queues";

export type ProviderCooldown = {
  active: boolean;
  until: string | null;
  remainingMs: number;
};

export async function getGlobalDatafeedsCooldown(now = new Date()): Promise<ProviderCooldown> {
  const client = await getMarketDataQueueRedisClient();
  if (!client) return { active: false, until: null, remainingMs: 0 };

  try {
    const raw = await client.get(GDF_RATE_LIMIT_REDIS_KEY);
    const blockedUntil = raw ? Number(raw) : 0;
    const remainingMs = Math.max(0, blockedUntil - now.getTime());
    return {
      active: remainingMs > 0,
      until: remainingMs > 0 ? new Date(blockedUntil).toISOString() : null,
      remainingMs,
    };
  } catch (error) {
    logger.warn(
      { message: getErrorMessage(error, "Unknown Redis error") },
      "Failed to read Global Datafeeds cooldown",
    );
    return { active: false, until: null, remainingMs: 0 };
  }
}

export async function assertGlobalDatafeedsAvailable() {
  const cooldown = await getGlobalDatafeedsCooldown();
  if (cooldown.active) throw new ProviderRateLimitedError("Global Datafeeds", cooldown.remainingMs);
  return cooldown;
}
