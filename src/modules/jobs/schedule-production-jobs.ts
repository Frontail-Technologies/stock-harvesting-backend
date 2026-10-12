import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { triggerPendingCollectionPreparations } from "../market-collections/market-collection-preparation.service";
import { listInstrumentSyncExchanges, listProductionExchanges } from "../market-data/market-data.universe";
import {
  scheduleCandleBootstrapReconciliation,
  scheduleRepeatableDailyCandleSync,
  scheduleRepeatableMarketDataSync,
} from "./queues";
import { reconcileWeeklyStrongBacktests } from "../weekly-strong-backtest/weekly-strong-backtest.reconciliation";

const SCHEDULE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
let scheduleRefreshInFlight: Promise<string[]> | null = null;

export function refreshProductionMarketDataSchedules(): Promise<string[]> {
  if (scheduleRefreshInFlight) return scheduleRefreshInFlight;
  scheduleRefreshInFlight = (async () => {
    const [syncExchanges, productionExchanges] = await Promise.all([
      listInstrumentSyncExchanges(),
      listProductionExchanges(),
    ]);
    await scheduleRepeatableMarketDataSync(syncExchanges);
    await scheduleRepeatableDailyCandleSync(productionExchanges);
    await scheduleCandleBootstrapReconciliation(productionExchanges);
    return productionExchanges;
  })().finally(() => {
    scheduleRefreshInFlight = null;
  });
  return scheduleRefreshInFlight;
}

export function startProductionMarketDataScheduleRefresh() {
  const refresh = () => void refreshProductionMarketDataSchedules().catch((error) => {
    logger.warn({ message: getErrorMessage(error, "Unknown error") }, "Failed to refresh market-data schedules");
  });
  refresh();
  const timer = setInterval(refresh, SCHEDULE_REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// Idempotent: registers repeatable jobs only for exchanges in the production
// universe (active instruments + a live provider) and removes schedulers left
// over for exchanges that no longer qualify.
export async function scheduleProductionMarketDataJobs() {
  try {
    const productionExchanges = await refreshProductionMarketDataSchedules();
    await Promise.all(productionExchanges.map((exchange) => reconcileWeeklyStrongBacktests(exchange)));
    await triggerPendingCollectionPreparations();
  } catch (error) {
    logger.warn(
      { message: getErrorMessage(error, "Unknown error") },
      "Failed to schedule production market-data jobs",
    );
  }
}
