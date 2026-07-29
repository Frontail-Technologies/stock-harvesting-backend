import { createServer } from "http";

import { createApp } from "./app";
import { pool } from "./db/client";
import { closeQueues, scheduleRepeatableMarketDataSync } from "./modules/jobs/queues";
import {
  attachMarketStreamGateway,
  closeMarketStreamProviders,
} from "./modules/market-stream";
import { env } from "./shared/env";
import { logger } from "./shared/logger";

const app = createApp();
const server = createServer(app);
const marketStreamGateway = attachMarketStreamGateway(server);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Backend listening");
  void scheduleRepeatableMarketDataSync();
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down backend");
  server.close(async () => {
    await marketStreamGateway.close();
    closeMarketStreamProviders();
    await closeQueues();
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
