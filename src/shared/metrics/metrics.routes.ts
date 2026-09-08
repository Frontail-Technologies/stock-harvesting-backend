import { Router } from "express";
import { env } from "../env";
import "./metrics";
import { metricsRegistry } from "./metrics.registry";
export const metricsRouter = Router();

metricsRouter.get("/metrics", async (req, res) => {
  if (env.METRICS_TOKEN) {
    const header = req.headers.authorization;
    if (header !== `Bearer ${env.METRICS_TOKEN}`) {
      res.status(401).end();
      return;
    }
  }

  res.set("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});
