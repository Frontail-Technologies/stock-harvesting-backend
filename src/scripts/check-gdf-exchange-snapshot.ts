import { pool } from "../db/client";
import {
  startGdfSessionBroker,
  stopGdfSessionBroker,
} from "../modules/data-provider/adapters/global-datafeeds/global-datafeeds.session-broker";
import { globalDatafeedsClient } from "../modules/data-provider/adapters/global-datafeeds/global-datafeeds.websocket-client";
import { env } from "../shared/env";
import { getErrorMessage } from "../shared/errors";

function parseArgs(argv: string[]) {
  let exchange = "BSE";
  let period = 15;
  let direct = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--exchange") exchange = (argv[++index] ?? "").trim().toUpperCase();
    else if (arg === "--period") period = Number(argv[++index]);
    else if (arg === "--direct") direct = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!exchange) throw new Error("--exchange is required");
  if (![1, 2, 5, 10, 15, 30].includes(period)) {
    throw new Error("--period must be one of 1, 2, 5, 10, 15, or 30");
  }
  return { exchange, period, direct };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!env.GLOBAL_DATAFEEDS_ENABLED || !env.GLOBAL_DATAFEEDS_API_KEY) {
    throw new Error("GLOBAL_DATAFEEDS_ENABLED / GLOBAL_DATAFEEDS_API_KEY are not configured");
  }

  const broker = args.direct ? null : startGdfSessionBroker("proxy");
  if (broker) {
    await broker.ready;
    if (!broker.isStarted()) {
      throw new Error("Cannot reach the worker's GDF session through Redis; stop the worker and retry with --direct");
    }
  }

  const response = await globalDatafeedsClient.request({
    MessageType: "GetExchangeSnapshot",
    Exchange: args.exchange,
    Periodicity: "MINUTE",
    Period: args.period,
    nonTraded: true,
  });
  if (response.MessageType === "RequestError") {
    throw new Error(`GetExchangeSnapshot rejected: ${String(response.Message ?? "request refused")}`);
  }

  const rows = Array.isArray(response.Result) ? response.Result : [];
  process.stdout.write(`${JSON.stringify({
    request: { exchange: args.exchange, periodicity: "MINUTE", period: args.period },
    response: {
      messageType: response.MessageType ?? null,
      rowCount: rows.length,
      sample: rows.slice(0, 3),
    },
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${getErrorMessage(error, "exchange snapshot check failed")}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopGdfSessionBroker().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
