import { count, eq } from "drizzle-orm";
import type { Gauge } from "prom-client";

import { db } from "../../db/client";
import { marketCollections } from "../../db/schema";
import { COLLECTION_PREPARATION_STATUSES } from "../../shared/constants";
import { registerCollectionsByPreparationStatusCollector } from "../../shared/metrics/metrics";

// One grouped query for every status - runs only when Prometheus actually scrapes /metrics (Gauge collect() hook), not on a timer or per-request.
async function refreshCollectionsByPreparationStatus(gauge: Gauge<"status">) {
  const rows = await db
    .select({ status: marketCollections.preparationStatus, total: count() })
    .from(marketCollections)
    .where(eq(marketCollections.active, true))
    .groupBy(marketCollections.preparationStatus);

  const totalsByStatus = new Map(rows.map((row) => [row.status, row.total]));
  for (const status of COLLECTION_PREPARATION_STATUSES) {
    gauge.set({ status }, totalsByStatus.get(status) ?? 0);
  }
}

export function registerMarketCollectionsMetricsCollectors() {
  registerCollectionsByPreparationStatusCollector(refreshCollectionsByPreparationStatus);
}
