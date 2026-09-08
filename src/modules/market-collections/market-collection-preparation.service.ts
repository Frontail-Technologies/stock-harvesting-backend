import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { marketCollections, weeklyStrongBacktestRuns } from "../../db/schema";
import { COLLECTION_PREPARATION_STATUS, JOB_NAMES } from "../../shared/constants";
import { env } from "../../shared/env";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getMarketDataQueue } from "../jobs/queues";
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

  try {
    await db
      .update(marketCollections)
      .set({ preparationStatus: COLLECTION_PREPARATION_STATUS.syncingCandles, updatedAt: new Date() })
      .where(eq(marketCollections.id, collectionId));

    const requiredFromDate = getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS);
    const todayDate = getTodayDate();
    const symbolsNeedingBackfill = await findSymbolsNeedingHistoryBackfill({
      exchange: collection.exchange,
      symbols,
      requiredFromDate,
    });

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

    await runWeeklyStrongBacktestBackfill({ collectionId });
    if (await hasExistingCurrentMembershipBacktest(collectionId)) {
      await runWeeklyStrongBacktestHistoricalRebuild({ collectionId }).catch((error) => {
        logger.warn(
          { collectionId, message: getErrorMessage(error, "Unknown error") },
          "Collection preparation: historical backtest rebuild failed"
        );
      });
    }

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

    const message = getErrorMessage(error, "Collection preparation failed").slice(0, 500);
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
      { collectionId, message, durationMs: Date.now() - startedAt },
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

export async function triggerCollectionPreparation(collectionId: string, membershipVersionId: string | null) {
  const queue = getMarketDataQueue();
  if (queue) {
    await queue.add(JOB_NAMES.collectionPrepare, { collectionId, membershipVersionId });
    return;
  }

  if (env.NODE_ENV === "production") {
    logger.warn(
      { collectionId, membershipVersionId },
      "Collection preparation: queue unavailable in production, leaving status pending for retry"
    );
    return;
  }

  void prepareCollectionData(collectionId, membershipVersionId).catch((error) => {
    logger.error(
      { collectionId, membershipVersionId, message: getErrorMessage(error, "Unknown error") },
      "Collection preparation (dev fallback) failed"
    );
  });
}
