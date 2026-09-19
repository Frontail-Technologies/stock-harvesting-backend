import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const upsertCandleBootstrapCheckpoint = vi.hoisted(() => vi.fn());
vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("./market-data.candle-bootstrap-checkpoints", () => ({ upsertCandleBootstrapCheckpoint }));

import type { DbOrTx } from "../../db/client";
import { calculateHistoricalCoverage } from "../jobs/market-data-job-ledger";
import { buildBootstrapCandidatesQuery, findActiveSymbolsWithoutDailyCandles } from "./market-data.candle-sync";
import {
  NO_HISTORY_CHECKPOINT_KIND,
  NO_HISTORY_RECHECK_INTERVAL_MS,
  isNoHistoryRecheckDue,
  listNoHistorySymbols,
  noHistoryRecheckCutoff,
  readNoHistoryConfirmedAt,
  recordNoHistoryConfirmed,
} from "./market-data.no-history";

const dialect = new PgDialect();
const T = new Date("2026-09-19T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const later = (ms: number) => new Date(T.getTime() + ms);

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

describe("recheck policy", () => {
  it("a confirmation is honored for the recheck interval and becomes eligible after it", () => {
    expect(NO_HISTORY_RECHECK_INTERVAL_MS).toBe(7 * DAY);
    expect(isNoHistoryRecheckDue(T, later(6 * DAY))).toBe(false);
    expect(isNoHistoryRecheckDue(T, later(7 * DAY))).toBe(true);
    expect(isNoHistoryRecheckDue(T, later(30 * DAY))).toBe(true);
  });

  it("never checked (no state) is always eligible", () => {
    expect(isNoHistoryRecheckDue(null, T)).toBe(true);
  });
});

describe("persisted no-history state", () => {
  it("is written as a successful, zero-candle checkpoint on the existing checkpoints table (survives a restart)", async () => {
    await recordNoHistoryConfirmed({
      exchange: "BSE_IDX",
      symbol: "1000EQ",
      requestedFrom: "2006-09-19",
      requestedTo: "2026-09-18",
    });

    expect(upsertCandleBootstrapCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        exchange: "BSE_IDX",
        symbol: "1000EQ",
        kind: NO_HISTORY_CHECKPOINT_KIND,
        status: "success",
        candleCount: 0,
      }),
      expect.anything()
    );
  });

  it("is read back from the database, not from process memory", async () => {
    const stored = new Date("2026-09-18T08:00:00.000Z");
    const db = { select: () => selectChain([{ completedAt: stored }]) } as unknown as DbOrTx;

    await expect(readNoHistoryConfirmedAt("BSE_IDX", "1000EQ", db)).resolves.toEqual(stored);
  });

  it("reads as never-checked when no row exists", async () => {
    const db = { select: () => selectChain([]) } as unknown as DbOrTx;

    await expect(readNoHistoryConfirmedAt("BSE_IDX", "1000EQ", db)).resolves.toBeNull();
  });

  it("lists every confirmed no-history symbol for an exchange", async () => {
    const db = { select: () => selectChain([{ symbol: "1000EQ" }, { symbol: "150M1I" }]) } as unknown as DbOrTx;

    await expect(listNoHistorySymbols("BSE_IDX", db)).resolves.toEqual(new Set(["1000EQ", "150M1I"]));
  });
});

describe("bootstrap candidate selection", () => {
  it("excludes instruments holding a fresh no-history confirmation, but only for the recheck window", () => {
    const { sql, params } = dialect.sqlToQuery(buildBootstrapCandidatesQuery("BSE_IDX", "global-datafeeds", 100, T));

    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1\s+FROM candles c/);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1\s+FROM candle_bootstrap_checkpoints b/);
    expect(sql).toMatch(/b\.completed_at > \$\d+/);
    expect(params).toContain(NO_HISTORY_CHECKPOINT_KIND);
    expect(params.some((param) => param instanceof Date && param.getTime() === noHistoryRecheckCutoff(T).getTime())).toBe(true);
  });

  it("the exclusion cutoff moves forward with time, so a confirmation ages back into eligibility", () => {
    // a confirmation made at T is excluded at T (completed_at > cutoff) and no longer excluded 8 days later
    expect(T.getTime() > noHistoryRecheckCutoff(T).getTime()).toBe(true);
    expect(T.getTime() > noHistoryRecheckCutoff(later(8 * DAY)).getTime()).toBe(false);

    const now = dialect.sqlToQuery(buildBootstrapCandidatesQuery("BSE_IDX", "global-datafeeds", 100, T)).params;
    const in8Days = dialect.sqlToQuery(buildBootstrapCandidatesQuery("BSE_IDX", "global-datafeeds", 100, later(8 * DAY))).params;
    expect(now).not.toEqual(in8Days);
  });

  it("still selects instruments with zero candles and no confirmation (genuinely missing history)", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ symbol: "NEWCO" }] }) } as unknown as DbOrTx;

    await expect(findActiveSymbolsWithoutDailyCandles("BSE", 100, T, db)).resolves.toEqual(["NEWCO"]);
  });

  it("selects nothing for a retired exchange", async () => {
    const db = { execute: vi.fn() } as unknown as DbOrTx;

    await expect(findActiveSymbolsWithoutDailyCandles("NSE", 100, T, db)).resolves.toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("completeness", () => {
  const universe = [
    { instrumentId: "a", symbol: "AAA" },
    { instrumentId: "b", symbol: "NOHIST" },
    { instrumentId: "c", symbol: "TIMEDOUT" },
  ];

  it("a confirmed no-history instrument does not keep coverage partial", () => {
    const coverage = calculateHistoricalCoverage(universe.slice(0, 2), ["a"], { exemptSymbols: ["NOHIST"] });

    expect(coverage).toMatchObject({ totalExpected: 1, completed: 1, missing: 0, coveragePct: 100, exempt: 1, missingSymbols: [] });
  });

  it("a symbol that failed (timeout/error/persistence) is not exempt and stays missing", () => {
    const coverage = calculateHistoricalCoverage(universe, ["a"], { exemptSymbols: ["NOHIST"] });

    expect(coverage.missingSymbols).toEqual(["TIMEDOUT"]);
    expect(coverage.missing).toBe(1);
    expect(coverage.exempt).toBe(1);
  });

  it("an unexplained missing symbol (never checked) still counts as missing", () => {
    const coverage = calculateHistoricalCoverage(universe, ["a"], { exemptSymbols: [] });

    expect(coverage.missingSymbols).toEqual(["NOHIST", "TIMEDOUT"]);
  });
});
