import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { publishRealtimeEvent } from "./realtime-events";
import { getMarketDataQueueRedisClient } from "./queues";
import { readWorkerHeartbeat, WORKER_NAMES, type WorkerStatus } from "./worker-heartbeat";

export async function getMarketDataWorkerStatuses(): Promise<WorkerStatus[]> {
  const client = await getMarketDataQueueRedisClient();
  if (!client) {
    return [{ name: WORKER_NAMES.marketData, status: "offline", lastHeartbeat: null, startedAt: null }];
  }
  return [await readWorkerHeartbeat(client, WORKER_NAMES.marketData)];
}

const WORKER_STATUS_POLL_INTERVAL_MS = 20_000;

export function startWorkerStatusChangeMonitor() {
  let lastKnownStatus: WorkerStatus["status"] | null = null;

  const check = async () => {
    try {
      const [status] = await getMarketDataWorkerStatuses();
      if (!status || status.status === lastKnownStatus) return;
      lastKnownStatus = status.status;
      void publishRealtimeEvent({
        kind: "admin",
        event: {
          type: "worker:status",
          data: { name: status.name, status: status.status, lastHeartbeat: status.lastHeartbeat },
        },
      });
    } catch (error) {
      logger.warn({ message: getErrorMessage(error, "Unknown error") }, "Worker status change check failed");
    }
  };

  void check();
  const timer = setInterval(() => void check(), WORKER_STATUS_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
