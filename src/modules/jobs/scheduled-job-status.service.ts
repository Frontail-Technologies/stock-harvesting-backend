import { SCHEDULED_DAILY_CANDLE_SYNC_JOB_TYPES, type BackgroundJobType } from "../../shared/constants";
import { getLatestBackgroundJobRunByType } from "./background-job-runs.service";
import { getRepeatableDailyCandleSyncJobs } from "./queues";

export type ScheduledJobStatus = {
  jobType: BackgroundJobType;
  nextRunAt: string | null;
  lastRun: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    processedCount: number;
    updatedCount: number;
    repairedCount: number;
    failedCount: number;
  } | null;
};

function schedulerIdMatchesJobType(id: string | null | undefined, jobType: BackgroundJobType) {
  if (!id) return false;
  const suffixByJobType: Record<BackgroundJobType, string> = {
    daily_candle_morning: "morning",
    daily_candle_post_market: "post-market",
    daily_candle_retry: "retry",
    chart_ensure_fresh: "",
  };
  const suffix = suffixByJobType[jobType];
  return suffix.length > 0 && id.endsWith(`-${suffix}`);
}

export async function getScheduledDailyCandleSyncStatuses(): Promise<ScheduledJobStatus[]> {
  const [schedulers, latestRunByType] = await Promise.all([
    getRepeatableDailyCandleSyncJobs(),
    getLatestBackgroundJobRunByType(SCHEDULED_DAILY_CANDLE_SYNC_JOB_TYPES),
  ]);

  return SCHEDULED_DAILY_CANDLE_SYNC_JOB_TYPES.map((jobType) => {
    const scheduler = schedulers.find((entry) => schedulerIdMatchesJobType(entry.id, jobType));
    const run = latestRunByType.get(jobType) ?? null;

    return {
      jobType,
      nextRunAt: scheduler?.next ? new Date(scheduler.next).toISOString() : null,
      lastRun: run
        ? {
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            processedCount: run.processedCount,
            updatedCount: run.updatedCount,
            repairedCount: run.repairedCount,
            failedCount: run.failedCount,
          }
        : null,
    };
  });
}
