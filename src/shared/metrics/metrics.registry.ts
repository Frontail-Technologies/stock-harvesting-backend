import { collectDefaultMetrics, Registry } from "prom-client";
export const METRICS_PREFIX = "stock_harvesting_";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: METRICS_PREFIX });
