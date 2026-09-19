import { describe, expect, it } from "vitest";

import { classifyBacktestReconciliation } from "./weekly-strong-backtest.reconciliation";

describe("classifyBacktestReconciliation", () => {
  it("queues an initial backfill for every active segment without current runs", () => {
    const result = classifyBacktestReconciliation({
      collectionIds: ["new", "ready"],
      currentIds: new Set(["ready"]),
      historicalIds: new Set(),
      versionedIds: new Set(),
    });

    expect(result.initialIds).toEqual(["new"]);
    expect(result.incrementalIds).toEqual(["ready"]);
  });

  it("queues historical generation only after current generation and a dated version exist", () => {
    const result = classifyBacktestReconciliation({
      collectionIds: ["versioned", "done", "unversioned"],
      currentIds: new Set(["versioned", "done", "unversioned"]),
      historicalIds: new Set(["done"]),
      versionedIds: new Set(["versioned", "done"]),
    });

    expect(result.historicalIds).toEqual(["versioned"]);
  });

  it("does not regenerate completed current or historical histories", () => {
    const result = classifyBacktestReconciliation({
      collectionIds: ["done"],
      currentIds: new Set(["done"]),
      historicalIds: new Set(["done"]),
      versionedIds: new Set(["done"]),
    });

    expect(result.initialIds).toEqual([]);
    expect(result.historicalIds).toEqual([]);
    expect(result.incrementalIds).toEqual(["done"]);
  });
});
