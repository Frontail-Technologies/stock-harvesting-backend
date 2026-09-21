import { and, desc, eq } from "drizzle-orm";

import { db, pool } from "../db/client";
import { candles, instruments } from "../db/schema";
import { GlobalDatafeedsDataProviderAdapter } from "../modules/data-provider/adapters/global-datafeeds/global-datafeeds.adapter";
import {
  startGdfSessionBroker,
  stopGdfSessionBroker,
} from "../modules/data-provider/adapters/global-datafeeds/global-datafeeds.session-broker";
import { CANDLE_TIMEFRAME } from "../shared/constants";
import { env } from "../shared/env";
import { getErrorMessage, isProviderRateLimitedError } from "../shared/errors";
import { normalizeSymbol } from "../shared/normalize";

// Read-only check: does GlobalDataFeeds have a daily candle for a symbol on a date, what does its
// live snapshot say, and what is stored in our database?
//
//   node dist/scripts/check-gdf-symbol-candles.js UTLSOLAR --date 2026-09-21        (on the server)
//   npx tsx src/scripts/check-gdf-symbol-candles.ts UTLSOLAR --date 2026-09-21
//
// GDF allows ONE session per key, so this script never opens its own socket: it asks the worker (the
// session owner) over Redis. Use --direct only after stopping the worker. It costs about 3 GDF calls.

export type CheckArgs = {
  symbol: string;
  date: string;
  exchange: string;
  lookbackDays: number;
  direct: boolean;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function indiaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function parseArgs(argv: string[], now = new Date()): CheckArgs {
  const args: CheckArgs = { symbol: "", date: indiaToday(now), exchange: "BSE", lookbackDays: 10, direct: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--direct") args.direct = true;
    else if (arg === "--date") args.date = argv[++index] ?? "";
    else if (arg === "--exchange") args.exchange = (argv[++index] ?? "").toUpperCase();
    else if (arg === "--days") args.lookbackDays = Number(argv[++index]);
    else if (!arg.startsWith("--") && !args.symbol) args.symbol = normalizeSymbol(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.symbol) throw new Error("Usage: check-gdf-symbol-candles <SYMBOL> [--date YYYY-MM-DD] [--exchange BSE] [--days 10] [--direct]");
  if (!DATE_PATTERN.test(args.date)) throw new Error(`--date must be YYYY-MM-DD, got "${args.date}"`);
  if (!Number.isInteger(args.lookbackDays) || args.lookbackDays < 1 || args.lookbackDays > 60) {
    throw new Error("--days must be a whole number between 1 and 60");
  }
  return args;
}

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function describeAvailability(input: {
  date: string;
  today: string;
  historyDates: string[];
  snapshotDate: string | null;
  storedDates: string[] | null;
}) {
  const inHistory = input.historyDates.includes(input.date);
  const snapshotMatches = input.snapshotDate === input.date;
  const stored = input.storedDates === null ? null : input.storedDates.includes(input.date);
  const lines = [
    `GDF daily history has ${input.date}: ${inHistory ? "YES" : "NO"}`,
    `GDF live snapshot is for ${input.date}: ${input.snapshotDate === null ? "no snapshot returned" : snapshotMatches ? "YES" : `NO (latest is ${input.snapshotDate})`}`,
    `Stored in our database: ${stored === null ? "unknown (database not reachable)" : stored ? "YES" : "NO"}`,
  ];
  let verdict: string;
  if (inHistory) verdict = `Available: GDF returns a daily candle for ${input.date}.`;
  else if (snapshotMatches && input.date === input.today) {
    verdict = "The day is still open or has not been finalised: today's data exists as a live snapshot only. The daily history candle normally appears after the market closes.";
  } else if (input.date >= input.today) {
    verdict = `Not available yet: ${input.date} is ${input.date === input.today ? "today" : "in the future"}, and GDF has no daily candle for it.`;
  } else {
    verdict = `Not available: GDF returned no daily candle for ${input.date} (holiday, suspended, or no trades). Check the other dates listed above.`;
  }
  return { lines, verdict, inHistory };
}

function line(message = "") {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = indiaToday();

  if (!env.GLOBAL_DATAFEEDS_ENABLED || !env.GLOBAL_DATAFEEDS_API_KEY) {
    throw new Error("GLOBAL_DATAFEEDS_ENABLED / GLOBAL_DATAFEEDS_API_KEY are not set in .env");
  }
  const broker = args.direct ? null : startGdfSessionBroker("proxy");
  if (!args.direct && !broker) {
    throw new Error(
      "Refusing to open a second GlobalDataFeeds session (only one is allowed per key). Run this where Redis is " +
        "configured and the worker is running, or stop the worker and pass --direct.",
    );
  }
  if (broker) {
    await broker.ready;
    if (!broker.isStarted()) {
      throw new Error(
        "Cannot reach Redis, so the worker's GlobalDataFeeds session is out of reach. Refusing to open a second session " +
          "with the production key. Run this on the server (where REDIS_URL works), or stop the worker and pass --direct.",
      );
    }
  }
  line(`Checking ${args.symbol} (${args.exchange}) for ${args.date}${args.date === today ? " (today, IST)" : ""}`);
  line(args.direct ? "Mode: DIRECT socket (the worker must be stopped)" : "Mode: through the worker's GDF session");
  line();

  const adapter = new GlobalDatafeedsDataProviderAdapter();
  const from = shiftDate(args.date, -args.lookbackDays);

  // The sync jobs request history with the instrument's STORED token, so the check does the same. Only if
  // the instrument is unknown does it fall back to searching GDF (and finally to the plain symbol).
  let storedInstrument: { instrumentToken: string; active: boolean; name: string; latestPriceAt: string | null } | null = null;
  try {
    [storedInstrument = null] = await db
      .select({
        instrumentToken: instruments.instrumentToken,
        active: instruments.active,
        name: instruments.name,
        latestPriceAt: instruments.latestPriceAt,
      })
      .from(instruments)
      .where(and(eq(instruments.exchange, args.exchange), eq(instruments.symbol, args.symbol)))
      .limit(1);
  } catch (error) {
    line(`Instrument lookup in the database failed: ${getErrorMessage(error, "unknown error")}`);
  }
  if (storedInstrument) {
    line(`Instrument in database: "${storedInstrument.name}"  token ${storedInstrument.instrumentToken}  active ${storedInstrument.active}  latest price date ${storedInstrument.latestPriceAt ?? "none"}`);
  } else {
    line("Instrument in database: not found");
  }
  line();

  let historyDates: string[] = [];
  try {
    const instrumentToken = storedInstrument?.instrumentToken ?? (await adapter.getInstrumentToken(args.symbol, args.exchange));
    const history = await adapter.fetchDailyCandles({
      instrumentToken,
      symbol: args.symbol,
      from,
      to: args.date,
      exchangeCode: args.exchange,
    });
    historyDates = history.map((candle) => candle.time);
    line(`GDF daily history ${from} .. ${args.date}: ${history.length} candle(s)  [instrument ${instrumentToken}]`);
    for (const candle of history) {
      line(`  ${candle.time}  O ${candle.open}  H ${candle.high}  L ${candle.low}  C ${candle.close}  V ${candle.volume}`);
    }
  } catch (error) {
    line(`GDF daily history failed: ${getErrorMessage(error, "unknown error")}`);
    if (isProviderRateLimitedError(error)) line("GDF is rate limiting this key right now; try again after the cooldown.");
  }
  line();

  let snapshotDate: string | null = null;
  try {
    const [snapshot] = await adapter.fetchDelayedSnapshot({ symbols: [args.symbol], exchangeCode: args.exchange });
    if (snapshot) {
      snapshotDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(snapshot.tradeTime));
      line(`GDF live snapshot: trade time ${snapshot.tradeTime} (IST date ${snapshotDate})`);
      line(`  O ${snapshot.open}  H ${snapshot.high}  L ${snapshot.low}  C ${snapshot.close}  V ${snapshot.volume ?? "-"}`);
    } else {
      line("GDF live snapshot: none returned for this symbol");
    }
  } catch (error) {
    line(`GDF live snapshot failed: ${getErrorMessage(error, "unknown error")}`);
  }
  line();

  let storedDates: string[] | null = null;
  try {
    const rows = await db
      .select({ time: candles.time, close: candles.close })
      .from(candles)
      .where(and(eq(candles.exchange, args.exchange), eq(candles.symbol, args.symbol), eq(candles.timeframe, CANDLE_TIMEFRAME.day)))
      .orderBy(desc(candles.time))
      .limit(args.lookbackDays);
    storedDates = rows.map((row) => row.time);
    line(`Stored daily candles (newest ${rows.length}): ${rows.map((row) => `${row.time} (close ${row.close})`).join(", ") || "none"}`);
  } catch (error) {
    line(`Database check failed: ${getErrorMessage(error, "unknown error")}`);
  }
  line();

  const result = describeAvailability({ date: args.date, today, historyDates, snapshotDate, storedDates });
  for (const summary of result.lines) line(summary);
  line();
  line(result.verdict);
  process.exitCode = result.inHistory ? 0 : 2;
}

// Only run when executed directly, so the helpers above can be imported by tests.
if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${getErrorMessage(error, "check failed")}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await stopGdfSessionBroker().catch(() => undefined);
      await pool.end().catch(() => undefined);
      process.exit(process.exitCode ?? 0);
    });
}
