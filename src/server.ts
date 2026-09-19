import { createServer } from "http";

import { createApp } from "./app";
import { pool } from "./db/client";
import { closeQueues } from "./modules/jobs/queues";
import { scheduleProductionMarketDataJobs } from "./modules/jobs/schedule-production-jobs";
import { startMarketDataLedgerReconciliation } from "./modules/jobs/market-data-job-ledger";
import { closeRealtimeEvents, subscribeRealtimeEvents } from "./modules/jobs/realtime-events";
import { startWorkerStatusChangeMonitor } from "./modules/jobs/worker-status.service";
import {
  attachMarketStreamGateway,
  closeMarketStreamProviders,
  publishAdminMarketDataEvent,
  publishMarketStreamEvent,
} from "./modules/market-stream";
import { env } from "./shared/env";
import { logger } from "./shared/logger";

const app = createApp();
const server = createServer(app);
const marketStreamGateway = attachMarketStreamGateway(server);

subscribeRealtimeEvents((message) => {
  if (message.kind === "admin") {
    publishAdminMarketDataEvent(message.event);
    return;
  }
  publishMarketStreamEvent({
    type: "market.symbol.refreshed",
    data: message.event,
  });
});

const stopWorkerStatusMonitor = startWorkerStatusChangeMonitor();

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Backend listening");
  void scheduleProductionMarketDataJobs();
  startMarketDataLedgerReconciliation();
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down backend");
  stopWorkerStatusMonitor();
  server.close(async () => {
    await marketStreamGateway.close();
    closeMarketStreamProviders();
    await closeQueues();
    await closeRealtimeEvents();
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
