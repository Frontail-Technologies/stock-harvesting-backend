import { describe, expect, it } from "vitest";

import { Counter } from "prom-client";

import {
  bullmqJobRunsTotal,
  candleBackfillsTotal,
  collectionPreparationsTotal,
  httpRequestsTotal,
  registerCollectionsByPreparationStatusCollector,
  safeInc,
} from "./metrics";
import { metricsRegistry } from "./metrics.registry";

function labelNamesOf(metric: unknown): string[] {
  return (metric as { labelNames: string[] }).labelNames;
}

describe("metrics registry", () => {
  it("A: initializes without duplicate-registration errors", async () => {
    const body = await metricsRegistry.metrics();
    expect(typeof body).toBe("string");
  });

  it("B: exposes the correct Prometheus content type", () => {
    expect(metricsRegistry.contentType).toContain("text/plain");
  });

  it("N: httpRequestsTotal only accepts the finite label set - method/route/status_class, never raw path/status code", () => {
    expect(labelNamesOf(httpRequestsTotal)).toEqual([
      "method",
      "route",
      "status_class",
    ]);
  });

  it("N: collectionPreparationsTotal is labelled by outcome only - never collectionId", () => {
    expect(labelNamesOf(collectionPreparationsTotal)).toEqual(["outcome"]);
  });

  it("N: candleBackfillsTotal is labelled by exchange/outcome only - never symbol", () => {
    expect(labelNamesOf(candleBackfillsTotal)).toEqual(["exchange", "outcome"]);
  });

  it("N: bullmqJobRunsTotal is labelled by queue/job_type/outcome only - never job id", () => {
    expect(labelNamesOf(bullmqJobRunsTotal)).toEqual([
      "queue",
      "job_type",
      "outcome",
    ]);
  });

  it("F/G/H: collection preparation outcomes are recordable at each finite label value", async () => {
    for (const outcome of ["ready", "partial", "failed", "stale"]) {
      collectionPreparationsTotal.inc({ outcome });
    }
    const body = await metricsRegistry.metrics();
    expect(body).toContain("stock_harvesting_collection_preparations_total");
  });

  it("O: safeInc swallows a labelling error instead of throwing into the caller's business operation", () => {
    const mismatched = new Counter({
      name: "test_metric_mismatched_labels",
      help: "test",
    });
    expect(() => safeInc(mismatched, { unexpected_label: "x" })).not.toThrow();
  });

  it("P: the collection-status gauge is refreshed via one registered collector call, not one query per status", async () => {
    let calls = 0;
    registerCollectionsByPreparationStatusCollector(async (gauge) => {
      calls += 1;
      gauge.set({ status: "ready" }, 1);
    });
    await metricsRegistry.metrics();
    expect(calls).toBe(1);
  });
});
