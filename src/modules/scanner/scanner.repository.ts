import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { scanResults } from "../../db/schema";
import type { CandleTimeframe } from "../../shared/constants";

export async function findScanResultRows(input: {
  exchange: string;
  timeframe: CandleTimeframe;
  symbol?: string;
  rule?: string;
  limit: number;
}) {
  const filters = [
    eq(scanResults.exchange, input.exchange),
    eq(scanResults.timeframe, input.timeframe),
    input.symbol ? eq(scanResults.symbol, input.symbol) : undefined,
    input.rule ? eq(scanResults.ruleKey, input.rule) : undefined,
  ].filter(Boolean);

  return db
    .select({
      id: scanResults.id,
      ruleKey: scanResults.ruleKey,
      exchange: scanResults.exchange,
      symbol: scanResults.symbol,
      timeframe: scanResults.timeframe,
      startTime: scanResults.startTime,
      endTime: scanResults.endTime,
      highlightTimes: scanResults.highlightTimes,
      metrics: scanResults.metrics,
    })
    .from(scanResults)
    .where(and(...filters))
    .orderBy(desc(scanResults.createdAt))
    .limit(input.limit);
}
