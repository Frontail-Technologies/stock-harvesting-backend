import { db } from "../db/client";
import { marketCollections } from "../db/schema";
import { getErrorMessage } from "../shared/errors";
import { prepareCollectionData } from "../modules/market-collections/market-collection-preparation.service";

// One-off ops script: runs collection preparation (candle backfill + Weekly
// Strong Backtest generation) for every market collection, sequentially, so
// production can backfill history for all collections without going through
// the admin Retry button one at a time. Reuses prepareCollectionData as-is -
// same status transitions, same stage-tagged preparation_error on failure -
// this is only a different caller, not a parallel pipeline.

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eqIndex)] = raw.slice(eqIndex + 1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const onlyCollectionId = typeof args.collection === "string" ? args.collection : undefined;

  const rows = await db
    .select({
      id: marketCollections.id,
      name: marketCollections.name,
      exchange: marketCollections.exchange,
      latestMembershipVersionId: marketCollections.latestMembershipVersionId,
    })
    .from(marketCollections);

  const targets = onlyCollectionId ? rows.filter((row) => row.id === onlyCollectionId) : rows;

  if (targets.length === 0) {
    console.log("No matching collections found.");
    return;
  }

  console.log(`Preparing ${targets.length} collection(s)...\n`);

  const results: Array<{ id: string; name: string; outcome: string; detail: string }> = [];

  for (const [index, collection] of targets.entries()) {
    const startedAt = Date.now();
    console.log(`[${index + 1}/${targets.length}] ${collection.exchange}:${collection.name} (${collection.id})`);

    try {
      const result = await prepareCollectionData(collection.id, collection.latestMembershipVersionId);
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const outcome = result.skipped ? "skipped (superseded)" : "done";
      const detail = result.skipped
        ? "-"
        : `members=${result.totalMembers} withHistory=${result.membersWithRequiredHistory} unavailable=${result.membersUnavailable}`;
      console.log(`  -> ${outcome} in ${durationSeconds}s  ${detail}`);
      results.push({ id: collection.id, name: collection.name, outcome, detail });
    } catch (error) {
      // prepareCollectionData already persists a failed status internally on
      // its own errors, so reaching this catch means something unexpected
      // (e.g. the collection lookup itself) - still record it, don't abort
      // the rest of the run.
      const message = getErrorMessage(error, "Unknown error");
      console.log(`  -> failed: ${message}`);
      results.push({ id: collection.id, name: collection.name, outcome: "failed", detail: message });
    }
  }

  const succeeded = results.filter((r) => r.outcome === "done").length;
  const skipped = results.filter((r) => r.outcome.startsWith("skipped")).length;
  const failed = results.filter((r) => r.outcome === "failed").length;

  console.log("\n=== Summary ===");
  console.log(`Total: ${results.length}`);
  console.log(`Done: ${succeeded}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed collections:");
    for (const result of results.filter((r) => r.outcome === "failed")) {
      console.log(`  ${result.name} (${result.id}) - ${result.detail}`);
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
