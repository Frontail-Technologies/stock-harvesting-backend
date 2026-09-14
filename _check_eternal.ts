import { getActiveMemberInstrumentRows } from "./src/modules/market-collections/market-collections.service";
import { readDailyAndWeeklyMetricCandles } from "./src/modules/market-data/market-data.metrics";
import { deriveScannerWeeklyCloses } from "./src/modules/scanner/scanner.candles";
import { calculateNear250WeekHighScan } from "./src/modules/scanner/rules/near-250-week-high";
import { classifyScannerWeeklySeries } from "./src/modules/scanner/rules/scanner-weekly-series-safety";
import {
  excludeIncompleteTradingWeek,
  evaluateWeeklyStrongSeries,
  evaluateWeeklyStrongLatest,
  hasSufficientWeeklyStrongHistory,
} from "./src/modules/market-data/weekly-strong-evaluator";
import { SCANNER_LOOKBACK_WEEKS } from "./src/modules/scanner/scanner.constants";
import { getWeekEndingFriday } from "./src/modules/market-data/trading-calendar";
import { getDateYearsAgo } from "./src/modules/market-data/market-data.dates";
import { groupMetricCandlesBySymbol } from "./src/modules/market-data/market-data.candles";
import { db } from "./src/db/client";
import { sql } from "drizzle-orm";

const COLLECTION_ID = "768a7cf8-7b5e-4c61-b362-f18923013647"; // BSE 100
const EXCHANGE = "BSE";
const SYMBOL = "ETERNAL";

async function main() {
  const members = await getActiveMemberInstrumentRows(COLLECTION_ID);
  const member = members.find((m) => m.symbol === SYMBOL);
  console.log("member found in BSE100:", !!member, member);

  if (!member) {
    // Maybe it's not in this collection - check instruments table directly.
    const rows = await db.execute(
      sql`select id, exchange, symbol, name, active from instruments where symbol ilike ${"%" + SYMBOL + "%"}`
    );
    console.log("instrument rows:", rows.rows);
    return;
  }

  const { dailyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange: EXCHANGE,
    instruments: [{ instrumentId: member.instrumentId, symbol: member.symbol }],
    dailyFrom: getDateYearsAgo(10),
    weeklyFrom: getDateYearsAgo(10),
  });
  const dailyBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const dailyRows = dailyBySymbol.get(SYMBOL) ?? [];
  console.log("dailyRows count:", dailyRows.length, "first:", dailyRows[0]?.time, "last:", dailyRows[dailyRows.length - 1]?.time);

  const weeklyCloses = deriveScannerWeeklyCloses(dailyRows.map((r) => ({ time: r.time, close: r.close })));
  const completed = excludeIncompleteTradingWeek(weeklyCloses, EXCHANGE);
  console.log("weekly closes:", weeklyCloses.length, "completed:", completed.length);

  const { segments, latestSegment, isLatestWeekFresh } = classifyScannerWeeklySeries(completed, EXCHANGE);
  console.log("segments:", segments.length, segments.map((s) => s.length), "latestSegment len:", latestSegment.length, "isLatestWeekFresh:", isLatestWeekFresh);

  const scan = calculateNear250WeekHighScan(segments, latestSegment, isLatestWeekFresh, SCANNER_LOOKBACK_WEEKS["5x"]);
  console.log("scan.matched:", scan?.matched, "lookbackWeeks used:", scan?.metrics.lookbackWeeks);
  console.log("highlightTimes tail:", scan?.highlightTimes.slice(-6));
  const latestWeekTime = latestSegment[latestSegment.length - 1]?.time;
  console.log("latestWeekTime:", latestWeekTime, "friday:", latestWeekTime ? getWeekEndingFriday(latestWeekTime) : null);
  console.log("highlightTimes last matches latestWeekTime:", scan?.highlightTimes[scan.highlightTimes.length - 1] === latestWeekTime);

  // Also check Weekly Strong inclusion side (whether it even shows in Harvest Results at all).
  const weeklyRowsWS = excludeIncompleteTradingWeek(
    (await readDailyAndWeeklyMetricCandles({ exchange: EXCHANGE, instruments: [{ instrumentId: member.instrumentId, symbol: member.symbol }], dailyFrom: getDateYearsAgo(10), weeklyFrom: getDateYearsAgo(10) })).weeklyCandles.filter(c => c.symbol === SYMBOL),
    EXCHANGE
  );
  console.log("hasSufficientHistory:", hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRowsWS.length));
  const wsSeries = evaluateWeeklyStrongSeries(dailyRows, weeklyRowsWS);
  console.log("Weekly Strong latest series entry passes:", wsSeries[wsSeries.length - 1]?.passes);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
