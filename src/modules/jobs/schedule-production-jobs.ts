import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { listInstrumentSyncExchanges, listProductionExchanges } from "../market-data/market-data.universe";
import {
  scheduleCandleBootstrapReconciliation,
  scheduleRepeatableDailyCandleSync,
  scheduleRepeatableMarketDataSync,
} from "./queues";
import { ensureExpectedMarketDataJobs, markExpectedMarketDataJobsQueued } from "./market-data-job-ledger";
import { reconcileWeeklyStrongBacktests } from "../weekly-strong-backtest/weekly-strong-backtest.reconciliation";

// Idempotent: registers repeatable jobs only for exchanges in the production
// universe (active instruments + a live provider) and removes schedulers left
// over for exchanges that no longer qualify.
export async function scheduleProductionMarketDataJobs() {
  try {
    const [syncExchanges, productionExchanges] = await Promise.all([
      listInstrumentSyncExchanges(),
      listProductionExchanges(),
    ]);

    await scheduleRepeatableMarketDataSync(syncExchanges);
    const queuedExchanges = await scheduleRepeatableDailyCandleSync(productionExchanges);
    await scheduleCandleBootstrapReconciliation(productionExchanges);
    await ensureExpectedMarketDataJobs(new Date(), productionExchanges);
    await markExpectedMarketDataJobsQueued(queuedExchanges ?? []);
    await Promise.all(productionExchanges.map((exchange) => reconcileWeeklyStrongBacktests(exchange)));
  } catch (error) {
    logger.warn(
      { message: getErrorMessage(error, "Unknown error") },
      "Failed to schedule production market-data jobs",
    );
  }
}
