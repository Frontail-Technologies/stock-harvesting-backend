import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { marketCollections, weeklyStrongBacktestRuns } from "../../db/schema";
import { COLLECTION_PREPARATION_STATUS, JOB_NAMES } from "../../shared/constants";
import { env } from "../../shared/env";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { addJobWithTimeout, getMarketDataQueue } from "../jobs/queues";
import { findSymbolsNeedingHistoryBackfill, groupMetricCandlesBySymbol } from "../market-data/market-data.candles";
import { runChartBackfillOnce } from "../market-data/market-data.candle-sync";
import { getDateYearsAgo, getTodayDate } from "../market-data/market-data.dates";
import {
  readDailyAndWeeklyMetricCandles,
  WEEKLY_STRONG_BACKTEST_FETCH_YEARS,
} from "../market-data/market-data.metrics";
import { hasSufficientWeeklyStrongHistory } from "../market-data/weekly-strong-evaluator";
import {
  collectionPreparationDurationSeconds,
  collectionPreparationMembersTotal,
  collectionPreparationsTotal,
  safeInc,
} from "../../shared/metrics/metrics";
import {
  runWeeklyStrongBacktestBackfill,
  runWeeklyStrongBacktestHistoricalRebuild,
} from "../weekly-strong-backtest/weekly-strong-backtest.generation";
import { CURRENT_MEMBERSHIP } from "../weekly-strong-backtest/weekly-strong-backtest.constants";
import { getActiveMemberInstrumentRows } from "./market-collections.service";

// Candle backfill + backtest generation for a collection's current membership; triggered post-import or via admin retry. See docs/MARKET_COLLECTIONS.md.

const BACKFILL_CONCURRENCY = 8;

async function runWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await run(item);
      }
    })
  );
}

async function isCurrentMembershipVersionStale(collectionId: string, membershipVersionId: string | null) {
  const [row] = await db
    .select({ latestMembershipVersionId: marketCollections.latestMembershipVersionId })
    .from(marketCollections)
    .where(eq(marketCollections.id, collectionId));
  return row?.latestMembershipVersionId !== membershipVersionId;
}

async function hasExistingCurrentMembershipBacktest(collectionId: string) {
  const [row] = await db
    .select({ id: weeklyStrongBacktestRuns.id })
    .from(weeklyStrongBacktestRuns)
    .where(
      and(
        eq(weeklyStrongBacktestRuns.collectionId, collectionId),
        eq(weeklyStrongBacktestRuns.membershipMode, CURRENT_MEMBERSHIP)
      )
    )
    .limit(1);
  return Boolean(row);
}

export type CollectionPreparationResult = {
  collectionId: string;
  skipped: boolean;
  totalMembers: number;
  membersWithRequiredHistory: number | null;
  membersUnavailable: number | null;
};

// Which pipeline stage was running when preparation failed - persisted into
// preparation_error and logged, so an admin sees "current_membership_backtest:
// [57014] canceling statement due to statement timeout" instead of a
// 500-char SQL dump.
type PreparationStage =
  | "coverage_detection"
  | "candle_backfill"
  | "current_membership_backtest"
  | "historical_membership_backtest"
  | "availability";

const PREPARATION_ERROR_MAX_LENGTH = 280;

// Builds a compact, admin-safe failure string: stage + DB error code (if
// any) + the underlying cause, never the failing SQL text or a stack trace.
// Drizzle prefixes the whole query onto error.message, so the useful DB
// cause lives on error.cause (a pg DatabaseError) - prefer that.
function summarizePreparationFailure(
  error: unknown,
  stage: PreparationStage
): { message: string; code: string | null } {
  const cause =
    error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const dbError =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown; message?: unknown })
      : undefined;

  const code = dbError && typeof dbError.code === "string" ? dbError.code : null;

  let detail: string;
  if (dbError && typeof dbError.message === "string" && dbError.message.trim()) {
    detail = dbError.message.trim();
  } else {
    const firstLine =
      getErrorMessage(error, "Preparation failed").split(/\r?\n/, 1)[0]?.trim() ??
      "Preparation failed";
    detail = /\b(select|insert into|update |delete from|params:)\b/i.test(firstLine)
      ? "database query failed"
      : firstLine;
  }

  const summary = `${stage}: ${code ? `[${code}] ` : ""}${detail}`;
  return {
    message:
      summary.length > PREPARATION_ERROR_MAX_LENGTH
        ? `${summary.slice(0, PREPARATION_ERROR_MAX_LENGTH - 3)}...`
        : summary,
    code,
  };
}

export async function prepareCollectionData(
  collectionId: string,
  membershipVersionId: string | null
): Promise<CollectionPreparationResult> {
  const startedAt = Date.now();
  const [collection] = await db.select().from(marketCollections).where(eq(marketCollections.id, collectionId));
  if (!collection) {
    // A queued/stale job whose collection was deleted in the meantime - no-op rather than throw, so it never fails noisily or writes state for a gone collection.
    recordPreparationOutcome("stale", startedAt);
    return {
      collectionId,
      skipped: true,
      totalMembers: 0,
      membersWithRequiredHistory: null,
      membersUnavailable: null,
    };
  }
  const members = await getActiveMemberInstrumentRows(collectionId);
  const symbols = members.map((member) => member.symbol);

  let stage: PreparationStage = "coverage_detection";

  try {
    await db
      .update(marketCollections)
      .set({ preparationStatus: COLLECTION_PREPARATION_STATUS.syncingCandles, updatedAt: new Date() })
      .where(eq(marketCollections.id, collectionId));

    const requiredFromDate = getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS);
    const todayDate = getTodayDate();
    // Batched + fail-closed inside findSymbolsNeedingHistoryBackfill - a
    // lookup failure here throws and lands in the catch below, it is never
    // silently treated as "every symbol needs backfill".
    const symbolsNeedingBackfill = await findSymbolsNeedingHistoryBackfill({
      exchange: collection.exchange,
      symbols,
      requiredFromDate,
    });

    stage = "candle_backfill";
    let backfillSucceeded = 0;
    let backfillFailed = 0;

    await runWithConcurrency(symbolsNeedingBackfill, BACKFILL_CONCURRENCY, async (symbol) => {
      try {
        await runChartBackfillOnce({
          symbol,
          from: requiredFromDate,
          to: todayDate,
          exchange: collection.exchange,
        });
        backfillSucceeded += 1;
      } catch (error) {
        backfillFailed += 1;
        logger.warn(
          {
            collectionId,
            symbol,
            exchange: collection.exchange,
            message: getErrorMessage(error, "Unknown backfill error"),
          },
          "Collection preparation: candle backfill failed for one symbol"
        );
      }
    });

    await db
      .update(marketCollections)
      .set({ preparationStatus: COLLECTION_PREPARATION_STATUS.buildingBacktest, updatedAt: new Date() })
      .where(eq(marketCollections.id, collectionId));

    stage = "current_membership_backtest";
    await runWeeklyStrongBacktestBackfill({ collectionId });

    stage = "historical_membership_backtest";
    if (await hasExistingCurrentMembershipBacktest(collectionId)) {
      await runWeeklyStrongBacktestHistoricalRebuild({ collectionId }).catch((error) => {
        logger.warn(
          { collectionId, message: getErrorMessage(error, "Unknown error") },
          "Collection preparation: historical backtest rebuild failed"
        );
      });
    }

    stage = "availability";
    const { membersWithRequiredHistory, membersUnavailable } = await computeAvailabilityCounts(
      collection.exchange,
      symbols
    );

    if (await isCurrentMembershipVersionStale(collectionId, membershipVersionId)) {
      logger.info(
        { collectionId, membershipVersionId },
        "Collection preparation: superseded by a newer import, skipping final status write"
      );
      recordPreparationOutcome("stale", startedAt);
      return {
        collectionId,
        skipped: true,
        totalMembers: symbols.length,
        membersWithRequiredHistory: null,
        membersUnavailable: null,
      };
    }

    await db
      .update(marketCollections)
      .set({
        preparationStatus:
          membersUnavailable === 0
            ? COLLECTION_PREPARATION_STATUS.ready
            : COLLECTION_PREPARATION_STATUS.partial,
        preparedAt: new Date(),
        preparationError: null,
        membersWithRequiredHistory,
        membersUnavailable,
        updatedAt: new Date(),
      })
      .where(eq(marketCollections.id, collectionId));

    logger.info(
      {
        collectionId,
        totalMembers: symbols.length,
        symbolsBackfilled: symbolsNeedingBackfill.length,
        backfillSucceeded,
        backfillFailed,
        membersWithRequiredHistory,
        membersUnavailable,
        durationMs: Date.now() - startedAt,
      },
      "Collection preparation completed"
    );

    const outcome = membersUnavailable === 0 ? "ready" : "partial";
    recordPreparationOutcome(outcome, startedAt);
    safeInc(collectionPreparationMembersTotal, { result: "with_required_history" }, membersWithRequiredHistory);
    safeInc(collectionPreparationMembersTotal, { result: "unavailable" }, membersUnavailable);

    return {
      collectionId,
      skipped: false,
      totalMembers: symbols.length,
      membersWithRequiredHistory,
      membersUnavailable,
    };
  } catch (error) {
    if (await isCurrentMembershipVersionStale(collectionId, membershipVersionId)) {
      recordPreparationOutcome("stale", startedAt);
      return {
        collectionId,
        skipped: true,
        totalMembers: symbols.length,
        membersWithRequiredHistory: null,
        membersUnavailable: null,
      };
    }

    const { message, code } = summarizePreparationFailure(error, stage);
    await db
      .update(marketCollections)
      .set({
        preparationStatus: COLLECTION_PREPARATION_STATUS.failed,
        preparationError: message,
        preparedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(marketCollections.id, collectionId));

    logger.error(
      {
        collectionId,
        membershipVersionId,
        stage,
        symbolCount: symbols.length,
        errorCode: code,
        durationMs: Date.now() - startedAt,
        message,
      },
      "Collection preparation failed"
    );

    recordPreparationOutcome("failed", startedAt);

    return {
      collectionId,
      skipped: false,
      totalMembers: symbols.length,
      membersWithRequiredHistory: null,
      membersUnavailable: null,
    };
  }
}

function recordPreparationOutcome(outcome: "ready" | "partial" | "failed" | "stale", startedAt: number) {
  safeInc(collectionPreparationsTotal, { outcome });
  try {
    collectionPreparationDurationSeconds.observe({ outcome }, (Date.now() - startedAt) / 1000);
  } catch {
    // Metrics must never break the operation they observe.
  }
}

async function computeAvailabilityCounts(exchange: string, symbols: string[]) {
  if (symbols.length === 0) return { membersWithRequiredHistory: 0, membersUnavailable: 0 };

  const dailyFrom = getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS);
  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom,
    weeklyFrom: dailyFrom,
  });
  const dailyBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const weeklyBySymbol = groupMetricCandlesBySymbol(weeklyCandles);

  let membersWithRequiredHistory = 0;
  let membersUnavailable = 0;
  for (const symbol of symbols) {
    const dailyCount = dailyBySymbol.get(symbol)?.length ?? 0;
    const weeklyCount = weeklyBySymbol.get(symbol)?.length ?? 0;
    if (hasSufficientWeeklyStrongHistory(dailyCount, weeklyCount)) {
      membersWithRequiredHistory += 1;
    } else {
      membersUnavailable += 1;
    }
  }

  return { membersWithRequiredHistory, membersUnavailable };
}

const COLLECTION_PREPARE_QUEUE_UNAVAILABLE_ERROR =
  "Collection preparation queue is currently unavailable. Retry once it recovers.";

function buildCollectionPrepareJobId(collectionId: string, membershipVersionId: string | null) {
  return `collection-prepare:${collectionId}:${membershipVersionId ?? "none"}`;
}

function runCollectionPreparationInlineDevFallback(collectionId: string, membershipVersionId: string | null) {
  void prepareCollectionData(collectionId, membershipVersionId).catch((error) => {
    logger.error(
      { collectionId, membershipVersionId, message: getErrorMessage(error, "Unknown error") },
      "Collection preparation (dev fallback) failed"
    );
  });
}

async function markCollectionPreparationQueueUnavailable(collectionId: string) {
  await db
    .update(marketCollections)
    .set({
      preparationStatus: COLLECTION_PREPARATION_STATUS.failed,
      preparationError: COLLECTION_PREPARE_QUEUE_UNAVAILABLE_ERROR,
      updatedAt: new Date(),
    })
    .where(eq(marketCollections.id, collectionId));
}

// Never runs heavy preparation inline in production - a down/unreachable queue there must persist
// a coherent failed+error state so the badge stops showing a false "Preparing" and Retry is
// available, rather than silently degrading into a potentially-huge backfill inside the API
// process. The dev-only inline fallback below exists purely for local convenience without a
// worker running, and is always loudly logged so it's never mistaken for the real job path.
export async function triggerCollectionPreparation(collectionId: string, membershipVersionId: string | null) {
  const queue = getMarketDataQueue();

  if (queue) {
    try {
      await addJobWithTimeout(
        queue,
        JOB_NAMES.collectionPrepare,
        { collectionId, membershipVersionId },
        { jobId: buildCollectionPrepareJobId(collectionId, membershipVersionId) }
      );
      return;
    } catch (error) {
      logger.warn(
        { collectionId, membershipVersionId, message: getErrorMessage(error, "Unknown error") },
        "Collection preparation: failed to enqueue job (Redis configured but unreachable?)"
      );

      if (env.NODE_ENV === "production") {
        await markCollectionPreparationQueueUnavailable(collectionId);
        return;
      }

      logger.warn(
        { collectionId, membershipVersionId },
        "Collection preparation: running inline (development-only fallback - worker/Redis unreachable)"
      );
      runCollectionPreparationInlineDevFallback(collectionId, membershipVersionId);
      return;
    }
  }

  if (env.NODE_ENV === "production") {
    logger.warn(
      { collectionId, membershipVersionId },
      "Collection preparation: queue unavailable in production, leaving status pending for retry"
    );
    return;
  }

  runCollectionPreparationInlineDevFallback(collectionId, membershipVersionId);
}
