import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getMarketDataQueue } from "./queues";

// A live view of the BullMQ market-data queue. Many jobs (scheduled instrument sync, candle
// bootstrap reconcile, chart ensure-fresh) never get a Postgres row, so the Job runs table cannot
// show them; this reads the queue itself.

const QUEUE_SNAPSHOT_STATES = ["active", "waiting", "delayed"] as const;
const QUEUE_SNAPSHOT_PER_STATE_LIMIT = 20;

export type QueueSnapshotState = (typeof QUEUE_SNAPSHOT_STATES)[number];

export type QueueSnapshotJob = {
  id: string;
  name: string;
  state: QueueSnapshotState;
  exchange: string | null;
  attemptsMade: number;
  addedAt: string | null;
  startedAt: string | null;
  runAt: string | null;
};

export type QueueSnapshot = {
  available: boolean;
  counts: Record<QueueSnapshotState, number>;
  jobs: QueueSnapshotJob[];
};

type QueueJobLike = {
  id?: string | number | null;
  name: string;
  data?: unknown;
  attemptsMade?: number;
  timestamp?: number;
  processedOn?: number;
  delay?: number;
};

const EMPTY_COUNTS: Record<QueueSnapshotState, number> = { active: 0, waiting: 0, delayed: 0 };

function iso(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

export function toQueueSnapshotJob(job: QueueJobLike, state: QueueSnapshotState): QueueSnapshotJob {
  const data = (job.data ?? {}) as { exchange?: unknown };
  const addedAt = job.timestamp;
  return {
    id: String(job.id ?? ""),
    name: job.name,
    state,
    exchange: typeof data.exchange === "string" ? data.exchange : null,
    attemptsMade: job.attemptsMade ?? 0,
    addedAt: iso(addedAt),
    startedAt: state === "active" ? iso(job.processedOn) : null,
    // A delayed job runs at its creation time plus its delay.
    runAt: state === "delayed" && addedAt && job.delay ? iso(addedAt + job.delay) : null,
  };
}

export async function getMarketDataQueueSnapshot(): Promise<QueueSnapshot> {
  const queue = getMarketDataQueue();
  if (!queue) return { available: false, counts: { ...EMPTY_COUNTS }, jobs: [] };

  try {
    const [counts, ...groups] = await Promise.all([
      queue.getJobCounts(...QUEUE_SNAPSHOT_STATES),
      ...QUEUE_SNAPSHOT_STATES.map((state) => queue.getJobs([state], 0, QUEUE_SNAPSHOT_PER_STATE_LIMIT - 1)),
    ]);
    const jobs = QUEUE_SNAPSHOT_STATES.flatMap((state, index) =>
      (groups[index] as QueueJobLike[]).filter(Boolean).map((job) => toQueueSnapshotJob(job, state)),
    );
    return {
      available: true,
      counts: {
        active: counts.active ?? 0,
        waiting: counts.waiting ?? 0,
        delayed: counts.delayed ?? 0,
      },
      jobs,
    };
  } catch (error) {
    logger.warn({ message: getErrorMessage(error, "Unknown error") }, "Failed to read the market-data queue snapshot");
    return { available: false, counts: { ...EMPTY_COUNTS }, jobs: [] };
  }
}
