import { eq, inArray } from "drizzle-orm";

import { db } from "../../db/client";
import { marketCollections } from "../../db/schema";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { invalidateCacheByPrefix } from "../../shared/cache";
import { notFound } from "../../shared/errors";
import { removeQueuedCollectionPrepareJobs } from "../jobs/queues";
import { invalidateCollectionSnapshots } from "../market-data/dashboard-snapshots.service";

const BULK_DELETE_MAX_IDS = 100;

type DeletedCollectionRow = { id: string; code: string; name: string };

// Hard-deletes a collection - market_collection_members, market_collection_versions (+ their members), and
// weekly_strong_backtest_runs (+ their members) all ON DELETE CASCADE from market_collections, so one DELETE
// removes the whole owned tree. Instruments/candles are never touched (owned by instruments, not collections).
export async function deleteMarketCollection(input: { id: string; actorUserId: string }) {
  const [deleted] = await db
    .delete(marketCollections)
    .where(eq(marketCollections.id, input.id))
    .returning({ id: marketCollections.id, code: marketCollections.code, name: marketCollections.name });
  if (!deleted) throw notFound("Collection not found");

  await cleanupAfterCollectionDelete([deleted]);

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_collection.deleted",
    targetType: "market_collection",
    targetId: deleted.id,
    metadata: { code: deleted.code, name: deleted.name },
  });

  return { deleted: true, id: deleted.id };
}

export async function bulkDeleteMarketCollections(input: { ids: string[]; actorUserId: string }) {
  const uniqueIds = [...new Set(input.ids)].slice(0, BULK_DELETE_MAX_IDS);

  // A single multi-row DELETE is already one atomic Postgres statement - either every matched row is removed or none are, no explicit BEGIN/COMMIT needed.
  const deletedRows = await db
    .delete(marketCollections)
    .where(inArray(marketCollections.id, uniqueIds))
    .returning({ id: marketCollections.id, code: marketCollections.code, name: marketCollections.name });

  const deletedIds = new Set(deletedRows.map((row) => row.id));
  const missingIds = uniqueIds.filter((id) => !deletedIds.has(id));

  await cleanupAfterCollectionDelete(deletedRows);

  await writeAuditLog({
    actorUserId: input.actorUserId,
    action: "market_collection.bulk_deleted",
    targetType: "market_collection",
    metadata: {
      requestedCount: uniqueIds.length,
      deletedCount: deletedRows.length,
      missingCount: missingIds.length,
      codes: deletedRows.map((row) => row.code),
    },
  });

  return {
    requestedCount: uniqueIds.length,
    deletedCount: deletedRows.length,
    missingCount: missingIds.length,
    missingIds,
  };
}

// App-level cleanup for what FK cascades can't reach: dashboard snapshots (scopeKey is a plain string, not an FK) and queued preparation jobs (BullMQ, not Postgres).
async function cleanupAfterCollectionDelete(deletedRows: DeletedCollectionRow[]) {
  if (deletedRows.length === 0) return;

  invalidateCacheByPrefix("collections:list");
  for (const row of deletedRows) {
    invalidateCacheByPrefix(`collectionMembers:${row.code}:`);
    invalidateCacheByPrefix(`collectionRelativeStrength:${row.code}:`);
    invalidateCacheByPrefix(`collectionWeeklyStrongStocks:${row.code}`);
    invalidateCacheByPrefix(`collectionWeeklyStrongBacktest:${row.code}`);
  }

  await Promise.all(deletedRows.map((row) => invalidateCollectionSnapshots(row.id)));
  await removeQueuedCollectionPrepareJobs(deletedRows.map((row) => row.id));
}
