import { createServer } from "http";
import { env } from "../env";
import { logger } from "../logger";
import { metricsRegistry } from "./metrics.registry";
import "./metrics";

export function startWorkerMetricsServer() {
  if (!env.WORKER_METRICS_PORT) return null;

  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }

    if (
      env.METRICS_TOKEN &&
      req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`
    ) {
      res.writeHead(401).end();
      return;
    }

    metricsRegistry
      .metrics()
      .then((body) => {
        res
          .writeHead(200, { "Content-Type": metricsRegistry.contentType })
          .end(body);
      })
      .catch((error: unknown) => {
        logger.error(
          { message: error instanceof Error ? error.message : "Unknown error" },
          "Worker metrics render failed",
        );
        res.writeHead(500).end();
      });
  });

  server.listen(env.WORKER_METRICS_PORT, "127.0.0.1", () => {
    logger.info(
      { port: env.WORKER_METRICS_PORT },
      "Worker metrics listener started",
    );
  });

  return server;
}
