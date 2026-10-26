import { GDF_RATE_LIMIT_REDIS_KEY } from "../data-provider/adapters/global-datafeeds/global-datafeeds.rate-limit";
import { ProviderRateLimitedError, getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getMarketDataQueueRedisClient } from "./queues";

export type ProviderCooldown = {
  active: boolean;
  until: string | null;
  remainingMs: number;
};

const COOLDOWN_READ_TIMEOUT_MS = 3_000;

export async function getGlobalDatafeedsCooldown(now = new Date()): Promise<ProviderCooldown> {
  const client = await getMarketDataQueueRedisClient();
  if (!client) return { active: false, until: null, remainingMs: 0 };

  let timer: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      client.get(GDF_RATE_LIMIT_REDIS_KEY),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Global Datafeeds cooldown read timed out")), COOLDOWN_READ_TIMEOUT_MS);
      }),
    ]);
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
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function assertGlobalDatafeedsAvailable() {
  const cooldown = await getGlobalDatafeedsCooldown();
  if (cooldown.active) throw new ProviderRateLimitedError("Global Datafeeds", cooldown.remainingMs);
  return cooldown;
}
