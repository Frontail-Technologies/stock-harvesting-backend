import Redis from "ioredis";

import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import type { AdminMarketDataEvent, MarketSymbolRefreshedEvent } from "../market-stream";
import { getProducerRedisConnectionOptions, getRedisConnectionOptions } from "./queues";

const REALTIME_EVENTS_CHANNEL = "market-data:realtime-events";
const PUBLISH_TIMEOUT_MS = 3_000;

export type RealtimeMessage =
  | { kind: "admin"; event: AdminMarketDataEvent }
  | { kind: "symbol"; event: MarketSymbolRefreshedEvent["data"] };

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let loggedPublisherError = false;
let loggedSubscriberError = false;

function getPublisher(): Redis | null {
  const connection = getProducerRedisConnectionOptions();
  if (!connection) return null;
  if (!publisher) {
    publisher = new Redis(connection);
    publisher.on("error", (error) => {
      if (loggedPublisherError) return;
      loggedPublisherError = true;
      logger.warn(
        { message: getErrorMessage(error, "Unknown error") },
        "Realtime events publisher Redis connection failed",
      );
    });
  }
  return publisher;
}

export async function publishRealtimeEvent(message: RealtimeMessage) {
  try {
    const client = getPublisher();
    if (!client) return;

    await Promise.race([
      client.publish(REALTIME_EVENTS_CHANNEL, JSON.stringify(message)),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out publishing realtime event")), PUBLISH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn({ message: getErrorMessage(error, "Unknown error") }, "Failed to publish realtime event");
  }
}

export function subscribeRealtimeEvents(onMessage: (message: RealtimeMessage) => void) {
  const connection = getRedisConnectionOptions();
  if (!connection) {
    logger.warn("Redis not configured; realtime event bridge not started");
    return null;
  }
  if (subscriber) return subscriber;

  subscriber = new Redis(connection);
  subscriber.on("error", (error) => {
    if (loggedSubscriberError) return;
    loggedSubscriberError = true;
    logger.warn(
      { message: getErrorMessage(error, "Unknown error") },
      "Realtime events subscriber Redis connection failed",
    );
  });
  subscriber.subscribe(REALTIME_EVENTS_CHANNEL).catch((error: unknown) => {
    logger.warn(
      { message: getErrorMessage(error, "Unknown error") },
      "Failed to subscribe to realtime events channel",
    );
  });
  subscriber.on("message", (channel, raw) => {
    if (channel !== REALTIME_EVENTS_CHANNEL) return;
    try {
      onMessage(JSON.parse(raw) as RealtimeMessage);
    } catch (error) {
      logger.warn(
        { message: getErrorMessage(error, "Unknown error") },
        "Failed to parse realtime event message",
      );
    }
  });

  return subscriber;
}

export async function closeRealtimeEvents() {
  await publisher?.quit().catch(() => undefined);
  await subscriber?.quit().catch(() => undefined);
  publisher = null;
  subscriber = null;
}
