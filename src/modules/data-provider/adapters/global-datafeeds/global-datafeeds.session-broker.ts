import { randomUUID } from "crypto";
import Redis from "ioredis";

import { HTTP_STATUS } from "../../../../shared/constants";
import { env } from "../../../../shared/env";
import { AppError, ERROR_CODES, getErrorMessage } from "../../../../shared/errors";
import { logger } from "../../../../shared/logger";
import type {
  GlobalDatafeedsQuoteRow,
  GlobalDatafeedsRequest,
  GlobalDatafeedsResponse,
} from "./global-datafeeds.types";
import { globalDatafeedsClient, type GlobalDatafeedsWebSocketClient } from "./global-datafeeds.websocket-client";

// GlobalDataFeeds allows ONE session per API key. With the API and the worker both opening their
// own socket, whichever connects second is refused ("Key already in use by other session") and its
// requests time out. The broker makes exactly one process the session owner:
//   - "owner-candidate" (the worker) competes for a Redis lease; the winner opens the only socket,
//     serves requests other processes send over Redis, and broadcasts quotes and connection status.
//   - "proxy" (the API) never opens a socket; every request is executed by the owner.
// A candidate that loses the lease behaves like a proxy, and takes over if the owner's lease expires.

export type GdfSessionRole = "owner-candidate" | "proxy";

const OWNER_KEY = "gdf:session:owner";
const REQUEST_CHANNEL = "gdf:rpc:request";
const QUOTES_CHANNEL = "gdf:quotes";
const STATUS_CHANNEL = "gdf:status";
const responseChannel = (instanceId: string) => `gdf:rpc:response:${instanceId}`;

export const GDF_LEASE_TTL_SECONDS = 15;
export const GDF_LEASE_RENEW_INTERVAL_MS = 5_000;
const RPC_TIMEOUT_MARGIN_MS = 5_000;

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type RpcRequestMessage = {
  id: string;
  replyTo: string;
  kind: "request" | "send";
  request: GlobalDatafeedsRequest;
  timeoutMs: number;
};

export type RpcResponseMessage =
  | { id: string; ok: true; response?: GlobalDatafeedsResponse }
  | { id: string; ok: false; error: { message: string; status?: number } };

type PendingRpc = {
  resolve: (message: RpcResponseMessage) => void;
  timeout: NodeJS.Timeout;
};

function redisOptions() {
  if (!env.REDIS_URL) return null;
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
  };
}

export function isGdfBrokerEnabled() {
  return (
    globalDatafeedsClient.isConfigured() &&
    env.GLOBAL_DATAFEEDS_SESSION_MODE === "broker" &&
    Boolean(env.REDIS_URL)
  );
}

export class GdfSessionBroker {
  readonly instanceId: string;
  private commands: Redis | null = null;
  private subscriber: Redis | null = null;
  private pending = new Map<string, PendingRpc>();
  private leaseTimer: NodeJS.Timeout | null = null;
  private owner = false;
  private stopped = false;
  private detachOwnerListeners: Array<() => void> = [];
  private loggedRedisError = false;

  constructor(
    private readonly role: GdfSessionRole,
    private readonly client: GlobalDatafeedsWebSocketClient = globalDatafeedsClient,
    private readonly startupLeaseWaitMs = (GDF_LEASE_TTL_SECONDS + 1) * 1_000,
  ) {
    this.instanceId = `${role}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  isOwner() {
    return this.owner;
  }

  async start() {
    const options = redisOptions();
    if (!options) return;

    this.commands = new Redis({ ...options, maxRetriesPerRequest: 2 });
    this.subscriber = new Redis(options);
    for (const connection of [this.commands, this.subscriber]) {
      connection.on("error", (error) => {
        if (this.loggedRedisError) return;
        this.loggedRedisError = true;
        logger.warn({ message: getErrorMessage(error, "Unknown error") }, "GDF session broker Redis error");
      });
    }
    this.subscriber.on("message", (channel, raw) => this.onMessage(channel, raw));

    await this.subscriber.subscribe(responseChannel(this.instanceId));
    // Until this process wins the lease it reaches GDF through the owner.
    this.becomeProxy();

    if (this.role === "owner-candidate") {
      // A crashed predecessor leaves its lease behind until the TTL runs out. Wait for it here so
      // the first jobs run on this process's own socket instead of failing against a dead owner.
      const deadline = Date.now() + this.startupLeaseWaitMs;
      await this.tryLease();
      while (!this.owner && !this.stopped && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await this.tryLease();
      }
      this.leaseTimer = setInterval(() => void this.tryLease(), GDF_LEASE_RENEW_INTERVAL_MS);
      this.leaseTimer.unref();
    }
    logger.info({ instanceId: this.instanceId, role: this.role, owner: this.owner }, "GDF session broker started");
  }

  async stop() {
    this.stopped = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (this.owner && this.commands) {
      await this.commands.eval(RELEASE_SCRIPT, 1, OWNER_KEY, this.instanceId).catch(() => undefined);
    }
    this.owner = false;
    this.detachOwner();
    this.client.setRemoteTransport(null);
    for (const pending of this.pending.values()) clearTimeout(pending.timeout);
    this.pending.clear();
    await this.subscriber?.quit().catch(() => undefined);
    await this.commands?.quit().catch(() => undefined);
  }

  // ---- ownership -----------------------------------------------------------------------------

  private async tryLease() {
    if (this.stopped || !this.commands) return;
    try {
      if (this.owner) {
        const renewed = await this.commands.eval(
          RENEW_SCRIPT,
          1,
          OWNER_KEY,
          this.instanceId,
          String(GDF_LEASE_TTL_SECONDS),
        );
        if (renewed !== 1) this.becomeProxy();
        return;
      }
      const acquired = await this.commands.set(OWNER_KEY, this.instanceId, "EX", GDF_LEASE_TTL_SECONDS, "NX");
      if (acquired === "OK") await this.becomeOwner();
    } catch (error) {
      logger.warn({ message: getErrorMessage(error, "Unknown error") }, "GDF session lease check failed");
    }
  }

  private async becomeOwner() {
    if (this.owner || !this.subscriber) return;
    this.owner = true;
    this.client.setRemoteTransport(null);
    await this.subscriber.unsubscribe(QUOTES_CHANNEL, STATUS_CHANNEL).catch(() => undefined);
    await this.subscriber.subscribe(REQUEST_CHANNEL);
    this.detachOwnerListeners = [
      this.client.addQuoteListener((quote) => void this.publish(QUOTES_CHANNEL, quote)),
      this.client.addStatusListener(
        (connected, message) => void this.publish(STATUS_CHANNEL, { connected, message }),
      ),
    ];
    logger.info({ instanceId: this.instanceId }, "GDF session owner acquired; this process holds the only socket");
  }

  private becomeProxy() {
    const wasOwner = this.owner;
    this.owner = false;
    this.detachOwner();
    if (wasOwner) {
      // Give the session back: closing the socket frees the key for the next owner.
      this.client.close();
      void this.subscriber?.unsubscribe(REQUEST_CHANNEL).catch(() => undefined);
      logger.warn({ instanceId: this.instanceId }, "GDF session lease lost; falling back to the session owner");
    }
    this.client.setRemoteTransport({
      request: (request, timeoutMs) => this.remoteRequest(request, timeoutMs),
      send: (request) => this.remoteSend(request),
    });
    void this.subscriber?.subscribe(QUOTES_CHANNEL, STATUS_CHANNEL).catch(() => undefined);
  }

  private detachOwner() {
    for (const detach of this.detachOwnerListeners) detach();
    this.detachOwnerListeners = [];
  }

  // ---- proxy side ----------------------------------------------------------------------------

  private async assertOwnerPresent() {
    const owner = await this.commands?.get(OWNER_KEY).catch(() => null);
    if (!owner) {
      throw new AppError(
        HTTP_STATUS.badGateway,
        ERROR_CODES.providerError,
        "Global Datafeeds session owner (the worker) is not running",
      );
    }
  }

  private async rpc(kind: RpcRequestMessage["kind"], request: GlobalDatafeedsRequest, timeoutMs: number) {
    await this.assertOwnerPresent();
    const id = randomUUID();
    const message: RpcRequestMessage = { id, replyTo: this.instanceId, kind, request, timeoutMs };
    const reply = new Promise<RpcResponseMessage>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: { message: `Global Datafeeds request timed out: ${request.MessageType}` } });
      }, timeoutMs + RPC_TIMEOUT_MARGIN_MS);
      this.pending.set(id, { resolve, timeout });
    });
    await this.commands?.publish(REQUEST_CHANNEL, JSON.stringify(message));
    return reply;
  }

  private async remoteRequest(request: GlobalDatafeedsRequest, timeoutMs: number) {
    const result = await this.rpc("request", request, timeoutMs);
    if (!result.ok) throw this.toError(result.error);
    return result.response as GlobalDatafeedsResponse;
  }

  private async remoteSend(request: GlobalDatafeedsRequest) {
    const result = await this.rpc("send", request, 5_000);
    if (!result.ok) throw this.toError(result.error);
  }

  private toError(error: { message: string; status?: number }) {
    return error.status
      ? new AppError(error.status, ERROR_CODES.providerError, error.message)
      : new Error(error.message);
  }

  // ---- messages ------------------------------------------------------------------------------

  private onMessage(channel: string, raw: string) {
    try {
      if (channel === responseChannel(this.instanceId)) {
        const message = JSON.parse(raw) as RpcResponseMessage;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        pending.resolve(message);
      } else if (channel === REQUEST_CHANNEL && this.owner) {
        void this.serve(JSON.parse(raw) as RpcRequestMessage);
      } else if (channel === QUOTES_CHANNEL && !this.owner) {
        this.client.ingestRemoteQuote(JSON.parse(raw) as GlobalDatafeedsQuoteRow);
      } else if (channel === STATUS_CHANNEL && !this.owner) {
        const status = JSON.parse(raw) as { connected: boolean; message?: string };
        this.client.ingestRemoteStatus(status.connected, status.message);
      }
    } catch (error) {
      logger.warn({ channel, message: getErrorMessage(error, "Unknown error") }, "GDF broker message dropped");
    }
  }

  private async serve(message: RpcRequestMessage) {
    let reply: RpcResponseMessage;
    try {
      if (message.kind === "send") {
        await this.client.send(message.request);
        reply = { id: message.id, ok: true };
      } else {
        const response = await this.client.request(message.request, message.timeoutMs);
        reply = { id: message.id, ok: true, response };
      }
    } catch (error) {
      reply = {
        id: message.id,
        ok: false,
        error: {
          message: getErrorMessage(error, "Global Datafeeds request failed"),
          ...(error instanceof AppError ? { status: error.status } : {}),
        },
      };
    }
    await this.publish(responseChannel(message.replyTo), reply);
  }

  private async publish(channel: string, payload: unknown) {
    try {
      await this.commands?.publish(channel, JSON.stringify(payload));
    } catch (error) {
      logger.warn({ channel, message: getErrorMessage(error, "Unknown error") }, "GDF broker publish failed");
    }
  }
}

let activeBroker: GdfSessionBroker | null = null;

// Called once at process start (worker: "owner-candidate", API: "proxy"). Scripts and tests that
// never call it keep the previous behavior: a direct socket. Requests wait for the broker's first
// ownership decision, so no process opens a socket before knowing whether it may.
export function startGdfSessionBroker(
  role: GdfSessionRole,
  client: GlobalDatafeedsWebSocketClient = globalDatafeedsClient,
) {
  if (activeBroker || !isGdfBrokerEnabled()) return null;
  const broker = new GdfSessionBroker(role, client);
  activeBroker = broker;
  const ready = broker.start().catch((error) => {
    logger.error(
      { message: getErrorMessage(error, "Unknown error") },
      "GDF session broker failed to start; using a direct socket",
    );
    client.setRemoteTransport(null);
  });
  client.setStartupGate(ready);
  return broker;
}

export async function stopGdfSessionBroker() {
  const broker = activeBroker;
  activeBroker = null;
  await broker?.stop();
}
