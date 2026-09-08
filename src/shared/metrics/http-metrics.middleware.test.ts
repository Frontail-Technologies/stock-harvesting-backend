import { createServer, type Server } from "http";

import express from "express";
import { beforeEach, describe, expect, it } from "vitest";

import { httpMetricsMiddleware } from "./http-metrics.middleware";
import { httpRequestsTotal } from "./metrics";
import { metricsRegistry } from "./metrics.registry";

function withApp(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(httpMetricsMiddleware);
  app.get("/api/admin/market-collections/:id/prepare", (_req, res) =>
    res.status(202).end(),
  );
  app.get("/metrics", (_req, res) => res.status(200).end());

  const server: Server = createServer(app);
  return new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      run(`http://127.0.0.1:${port}`)
        .then(() => server.close(() => resolve()))
        .catch((error) => server.close(() => reject(error)));
    });
  });
}

describe("httpMetricsMiddleware", () => {
  beforeEach(() => {
    httpRequestsTotal.reset();
  });

  it("C/E: records the matched ROUTE TEMPLATE as the label, never the raw dynamic path", async () => {
    await withApp(async (baseUrl) => {
      await fetch(
        `${baseUrl}/api/admin/market-collections/real-collection-id-abc123/prepare`,
      );

      const body = await metricsRegistry.metrics();
      expect(body).toContain(
        'route="/api/admin/market-collections/:id/prepare"',
      );
      expect(body).not.toContain("real-collection-id-abc123");
    });
  });

  it("D: an unmatched route is labelled as a single fixed bucket, not the raw attempted path", async () => {
    await withApp(async (baseUrl) => {
      await fetch(`${baseUrl}/api/totally/made/up/xyz-987`);

      const body = await metricsRegistry.metrics();
      expect(body).toContain('route="unmatched"');
      expect(body).not.toContain("xyz-987");
    });
  });

  it("records status_class as a 2-digit class, not the exact status code", async () => {
    await withApp(async (baseUrl) => {
      await fetch(`${baseUrl}/api/admin/market-collections/c1/prepare`);

      const body = await metricsRegistry.metrics();
      expect(body).toContain('status_class="2xx"');
    });
  });

  it("excludes /metrics itself from the counted requests", async () => {
    await withApp(async (baseUrl) => {
      await fetch(`${baseUrl}/metrics`);

      const body = await metricsRegistry.metrics();
      expect(body).not.toContain('route="/metrics"');
    });
  });
});
