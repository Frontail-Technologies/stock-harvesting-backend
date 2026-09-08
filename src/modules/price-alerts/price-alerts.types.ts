import type { z } from "zod";

import type { priceAlertConditionSchema, priceAlertStatusSchema } from "./price-alerts.schemas";

export type PriceAlertCondition = z.infer<typeof priceAlertConditionSchema>;
export type PriceAlertStatus = z.infer<typeof priceAlertStatusSchema>;
