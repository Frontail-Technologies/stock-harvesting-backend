import type { Job } from "bullmq";
import { DEFAULT_EXCHANGE, JOB_NAMES } from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import { recordChartEnsureFreshResultIfNeeded } from "../jobs/background-job-runs.service";
import { getMarketDataQueue, getMarketDataQueueEvents } from "../jobs/queues";
import { refreshDailyCandles, type DailyCandleSyncResult, type DailyCandleSyncStatus } from "./market-data.candle-sync";
import { getLatestExpectedTradingDay } from "./trading-calendar";

export type EnsureFreshDailyCandlesStatus = DailyCandleSyncStatus | "in-progress";

export type EnsureFreshDailyCandlesResult = {
  status: EnsureFreshDailyCandlesStatus;
  changed: boolean;
  latestExpectedDate: string;
};

const CHANGED_STATUSES = new Set<EnsureFreshDailyCandlesStatus>(["updated", "repaired"]);

const ENSURE_FRESH_JOB_RETENTION_SECONDS = 20 * 60 * 60;
const ENSURE_FRESH_QUEUE_LOOKUP_TIMEOUT_MS = 3_000;
const ENSURE_FRESH_REPAIR_WAIT_TIMEOUT_MS = 90_000;
const JOB_WAIT_TIMEOUT_MESSAGE = "timed out before finishing";
const REPAIR_WAIT_TIMEOUT_MESSAGE = "Timed out waiting for the chart candle repair";

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function toResult(
  status: EnsureFreshDailyCandlesStatus,
  latestExpectedDate: string
): EnsureFreshDailyCandlesResult {
  return { status, changed: CHANGED_STATUSES.has(status), latestExpectedDate };
}

function buildEnsureFreshKey(exchange: string, symbol: string, latestExpectedDate: string) {
  return `chart-ensure-fresh-v2-${exchange}-${symbol}-${latestExpectedDate}`;
}

const inMemoryResults = new Map<string, DailyCandleSyncResult>();
const inMemoryInFlight = new Map<string, Promise<DailyCandleSyncResult>>();

function runInMemoryFallback(input: { symbol: string; exchange: string }, key: string) {
  const cached = inMemoryResults.get(key);
  if (cached && cached.status !== "failed") return Promise.resolve(cached);

  const existing = inMemoryInFlight.get(key);
  if (existing) return existing;

  const promise = refreshDailyCandles(input)
    .then((result) => {
      inMemoryResults.set(key, result);
      void recordChartEnsureFreshResultIfNeeded(result, input.symbol, input.exchange);
      return result;
    })
    .catch((error) => {
      logger.error(
        { exchange: input.exchange, symbol: input.symbol, message: getErrorMessage(error, "Unknown error") },
        "Chart candle ensure-fresh repair failed"
      );
      throw error;
    })
    .finally(() => {
      inMemoryInFlight.delete(key);
    });
  inMemoryInFlight.set(key, promise);
  return promise;
}

async function waitForJobWithinBudget(
  job: Job,
  latestExpectedDate: string
): Promise<EnsureFreshDailyCandlesResult> {
  const queueEvents = getMarketDataQueueEvents();
  if (!queueEvents) return toResult("in-progress", latestExpectedDate);

  try {
    const returnValue = (await job.waitUntilFinished(
      queueEvents,
      ENSURE_FRESH_REPAIR_WAIT_TIMEOUT_MS
    )) as DailyCandleSyncResult;
    return toResult(returnValue.status, latestExpectedDate);
  } catch (error) {
    if (error instanceof Error && error.message.includes(JOB_WAIT_TIMEOUT_MESSAGE)) {
      return toResult("in-progress", latestExpectedDate);
    }
    return toResult("failed", latestExpectedDate);
  }
}

export async function ensureFreshDailyCandles(input: {
  symbol: string;
  exchange?: string;
  waitForCompletion?: boolean;
}): Promise<EnsureFreshDailyCandlesResult> {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const latestExpectedDate = getLatestExpectedTradingDay(exchange);
  const jobId = buildEnsureFreshKey(exchange, symbol, latestExpectedDate);
  const waitForCompletion = input.waitForCompletion ?? true;

  const queue = getMarketDataQueue();
  if (!queue) {
    if (!waitForCompletion) {
      void runInMemoryFallback({ symbol, exchange }, jobId);
      return toResult("in-progress", latestExpectedDate);
    }
    return withTimeoutOrInProgress(runInMemoryFallback({ symbol, exchange }, jobId), latestExpectedDate);
  }

  try {
    const existingJob = await withTimeout(
      queue.getJob(jobId),
      ENSURE_FRESH_QUEUE_LOOKUP_TIMEOUT_MS,
      "Timed out looking up the chart candle ensure-fresh job"
    );
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "completed") {
        const returnValue = existingJob.returnvalue as DailyCandleSyncResult | undefined;
        if (returnValue && returnValue.status !== "failed" && returnValue.status !== "bootstrap-required") {
          return toResult(returnValue.status, latestExpectedDate);
        }
        await existingJob.remove().catch(() => undefined);
      } else if (state === "failed") {
        await existingJob.remove().catch(() => undefined);
      } else {
        if (!waitForCompletion) return toResult("in-progress", latestExpectedDate);
        return waitForJobWithinBudget(existingJob, latestExpectedDate);
      }
    }

    const newJob = await withTimeout(
      queue.add(
        JOB_NAMES.chartCandleEnsureFresh,
        { symbol, exchange },
        {
          jobId,
          removeOnComplete: { age: ENSURE_FRESH_JOB_RETENTION_SECONDS },
          removeOnFail: true,
        }
      ),
      ENSURE_FRESH_QUEUE_LOOKUP_TIMEOUT_MS,
      "Timed out enqueueing the chart candle ensure-fresh job"
    );
    if (!waitForCompletion) return toResult("in-progress", latestExpectedDate);
    return waitForJobWithinBudget(newJob, latestExpectedDate);
  } catch (error) {
    logger.warn(
      { exchange, symbol, message: getErrorMessage(error, "Unknown error") },
      "Chart candle ensure-fresh queue unavailable, falling back to inline check"
    );
    return withTimeoutOrInProgress(runInMemoryFallback({ symbol, exchange }, jobId), latestExpectedDate);
  }
}

async function withTimeoutOrInProgress(
  promise: Promise<DailyCandleSyncResult>,
  latestExpectedDate: string
): Promise<EnsureFreshDailyCandlesResult> {
  try {
    const result = await withTimeout(promise, ENSURE_FRESH_REPAIR_WAIT_TIMEOUT_MS, REPAIR_WAIT_TIMEOUT_MESSAGE);
    return toResult(result.status, latestExpectedDate);
  } catch (error) {
    if (error instanceof Error && error.message === REPAIR_WAIT_TIMEOUT_MESSAGE) {
      return toResult("in-progress", latestExpectedDate);
    }
    return toResult("failed", latestExpectedDate);
  }
}
