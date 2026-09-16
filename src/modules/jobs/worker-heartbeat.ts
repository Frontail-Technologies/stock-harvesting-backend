import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";

export const WORKER_NAMES = {
  marketData: "market-data-worker",
} as const;

export type WorkerName = (typeof WORKER_NAMES)[keyof typeof WORKER_NAMES];

export const WORKER_HEARTBEAT_INTERVAL_MS = 20_000;
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;
const WORKER_HEARTBEAT_STALE_MS = 90_000;
const WORKER_HEARTBEAT_KEY_PREFIX = "worker-heartbeat:";

type RedisSetGetClient = {
  set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
};

type WorkerHeartbeatPayload = {
  startedAt: string;
  lastHeartbeat: string;
};

export type WorkerStatus = {
  name: WorkerName;
  status: "online" | "offline";
  lastHeartbeat: string | null;
  startedAt: string | null;
};

function heartbeatKey(workerName: WorkerName) {
  return `${WORKER_HEARTBEAT_KEY_PREFIX}${workerName}`;
}

export async function writeWorkerHeartbeat(
  client: RedisSetGetClient,
  workerName: WorkerName,
  startedAt: string,
  now: Date = new Date()
) {
  const payload: WorkerHeartbeatPayload = { startedAt, lastHeartbeat: now.toISOString() };
  try {
    await client.set(heartbeatKey(workerName), JSON.stringify(payload), { EX: WORKER_HEARTBEAT_TTL_SECONDS });
  } catch (error) {
    logger.warn({ workerName, message: getErrorMessage(error, "Unknown error") }, "Failed to write worker heartbeat");
  }
}

export async function readWorkerHeartbeat(
  client: RedisSetGetClient,
  workerName: WorkerName,
  now: Date = new Date()
): Promise<WorkerStatus> {
  try {
    const raw = await client.get(heartbeatKey(workerName));
    if (!raw) return { name: workerName, status: "offline", lastHeartbeat: null, startedAt: null };

    const parsed = JSON.parse(raw) as WorkerHeartbeatPayload;
    const lastHeartbeatMs = Date.parse(parsed.lastHeartbeat);
    const isStale = !Number.isFinite(lastHeartbeatMs) || now.getTime() - lastHeartbeatMs > WORKER_HEARTBEAT_STALE_MS;

    return {
      name: workerName,
      status: isStale ? "offline" : "online",
      lastHeartbeat: parsed.lastHeartbeat,
      startedAt: parsed.startedAt,
    };
  } catch (error) {
    logger.warn({ workerName, message: getErrorMessage(error, "Unknown error") }, "Failed to read worker heartbeat");
    return { name: workerName, status: "offline", lastHeartbeat: null, startedAt: null };
  }
}
