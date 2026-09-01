import { describe, expect, it } from "vitest";

import type { DbOrTx } from "../../db/client";
import { applyLatestInstrumentStats, type LatestInstrumentStat } from "./market-data.service";

/**
 * No Postgres instance is reachable in this environment (same constraint as
 * market-data.backfill-atomicity.test.ts). What this proves: given the
 * exact `UPDATE ... FROM (VALUES ...)` statement applyLatestInstrumentStats
 * builds, simulating real Postgres semantics for it (match on exchange +
 * symbol, set the 5 stat columns + updated_at, leave non-matching rows
 * alone) produces the same final state the old one-UPDATE-per-symbol loop
 * would have. This is a behavior/state test, not a SQL-string comparison -
 * the fake below actually walks the query's real parameter values (via
 * Drizzle's own queryChunks, not string parsing) and applies them to a
 * fake `instruments` table the same way Postgres would.
 */

type FakeInstrumentRow = {
  id: string;
  exchange: string;
  symbol: string;
  latestClose: string | null;
  latestOpen: string | null;
  latestVolume: string | null;
  latestChangePct: string | null;
  latestPriceAt: string | null;
  updatedAt: string;
};

// Recursively flattens a Drizzle `sql` template (including nested SQL
// objects from sql.join(...)) into alternating text/param segments, in
// the exact order Postgres would see them - see the diagnostic exploration
// this was built from: queryChunks holds StringChunk objects (raw SQL
// text) interleaved with the raw interpolated JS values themselves.
function flattenQuery(query: unknown, out: Array<{ type: "text" | "param"; value: unknown }> = []) {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      flattenQuery(chunk, out);
    } else if (
      chunk &&
      typeof chunk === "object" &&
      "value" in chunk &&
      Array.isArray((chunk as { value: unknown }).value)
    ) {
      out.push({ type: "text", value: (chunk as { value: string[] }).value.join("") });
    } else {
      out.push({ type: "param", value: chunk });
    }
  }
  return out;
}

function createFakeDb(seedRows: FakeInstrumentRow[]) {
  const rows = [...seedRows];
  let executeCount = 0;

  const fakeDb = {
    execute: async (query: unknown) => {
      executeCount++;
      const segments = flattenQuery(query);
      const text = segments
        .filter((s) => s.type === "text")
        .map((s) => s.value)
        .join("");
      const params = segments.filter((s) => s.type === "param").map((s) => s.value);

      // Sanity-check this is genuinely the bulk statement shape, not just
      // trusting the caller - a real (if light) structural assertion, not
      // a full string comparison.
      if (!text.includes("FROM (VALUES") || !text.includes("UPDATE instruments")) {
        throw new Error(`Unexpected query shape in fake execute(): ${text}`);
      }

      // Last param is the exchange (WHERE i.exchange = ?); every group of
      // 6 before it is one VALUES row (symbol, close, open, volume,
      // change_pct, price_at), matching applyLatestInstrumentStats's own
      // row shape exactly.
      const exchange = params[params.length - 1] as string;
      const rowParams = params.slice(0, -1);
      for (let i = 0; i < rowParams.length; i += 6) {
        const [symbol, close, open, volume, changePct, priceAt] = rowParams.slice(i, i + 6);
        const target = rows.find((r) => r.exchange === exchange && r.symbol === symbol);
        if (!target) continue; // Postgres: UPDATE matches 0 rows for a non-existent (exchange,symbol) - no-op, not an error.
        target.latestClose = close === null ? null : String(close);
        target.latestOpen = open === null ? null : String(open);
        target.latestVolume = volume === null ? null : String(volume);
        target.latestChangePct = changePct === null ? null : String(changePct);
        target.latestPriceAt = priceAt === null ? null : String(priceAt);
        target.updatedAt = "now()";
      }

      return { rows: [] };
    },
  };

  return { fakeDb, getRows: () => rows, getExecuteCount: () => executeCount };
}

function seedRow(overrides: Partial<FakeInstrumentRow> & { symbol: string; exchange: string }): FakeInstrumentRow {
  return {
    id: `${overrides.exchange}:${overrides.symbol}`,
    latestClose: null,
    latestOpen: null,
    latestVolume: null,
    latestChangePct: null,
    latestPriceAt: null,
    updatedAt: "2020-01-01T00:00:00Z",
    ...overrides,
  };
}

function stat(overrides: Partial<LatestInstrumentStat> = {}): LatestInstrumentStat {
  return { close: 100, open: 99, volume: 1000, changePct: 1.5, time: "2026-01-05", ...overrides };
}

describe("applyLatestInstrumentStats", () => {
  it("updates all five stat fields plus updatedAt for multiple matching symbols in one statement", async () => {
    const { fakeDb, getRows, getExecuteCount } = createFakeDb([
      seedRow({ exchange: "NSE", symbol: "TCS" }),
      seedRow({ exchange: "NSE", symbol: "INFY" }),
    ]);

    await applyLatestInstrumentStats(
      "NSE",
      new Map([
        ["TCS", stat({ close: 3500, open: 3480, volume: 12000, changePct: 0.6, time: "2026-01-05" })],
        ["INFY", stat({ close: 1500, open: 1490, volume: 8000, changePct: -0.4, time: "2026-01-05" })],
      ]),
      fakeDb as unknown as DbOrTx
    );

    expect(getExecuteCount()).toBe(1);
    const rows = getRows();
    expect(rows.find((r) => r.symbol === "TCS")).toMatchObject({
      latestClose: "3500",
      latestOpen: "3480",
      latestVolume: "12000",
      latestChangePct: "0.6",
      latestPriceAt: "2026-01-05",
    });
    expect(rows.find((r) => r.symbol === "INFY")).toMatchObject({
      latestClose: "1500",
      latestChangePct: "-0.4",
    });
  });

  it("writes a NULL latest_change_pct when the stat's changePct is null (no prior close to diff against)", async () => {
    const { fakeDb, getRows } = createFakeDb([seedRow({ exchange: "NSE", symbol: "NEWLISTING" })]);

    await applyLatestInstrumentStats(
      "NSE",
      new Map([["NEWLISTING", stat({ changePct: null })]]),
      fakeDb as unknown as DbOrTx
    );

    expect(getRows()[0].latestChangePct).toBeNull();
  });

  it("a chunk where every row has a null changePct does not break the update (Postgres type-inference edge case)", async () => {
    const { fakeDb, getRows } = createFakeDb([
      seedRow({ exchange: "NSE", symbol: "A" }),
      seedRow({ exchange: "NSE", symbol: "B" }),
    ]);

    await applyLatestInstrumentStats(
      "NSE",
      new Map([
        ["A", stat({ changePct: null })],
        ["B", stat({ changePct: null })],
      ]),
      fakeDb as unknown as DbOrTx
    );

    expect(getRows().every((r) => r.latestChangePct === null)).toBe(true);
    expect(getRows().every((r) => r.latestClose === "100")).toBe(true);
  });

  it("only updates rows matching BOTH exchange and symbol - same symbol on a different exchange is untouched", async () => {
    const { fakeDb, getRows } = createFakeDb([
      seedRow({ exchange: "NSE", symbol: "RELIANCE" }),
      seedRow({ exchange: "BSE", symbol: "RELIANCE" }),
    ]);

    await applyLatestInstrumentStats(
      "NSE",
      new Map([["RELIANCE", stat({ close: 2500 })]]),
      fakeDb as unknown as DbOrTx
    );

    const rows = getRows();
    expect(rows.find((r) => r.exchange === "NSE")?.latestClose).toBe("2500");
    expect(rows.find((r) => r.exchange === "BSE")?.latestClose).toBeNull();
  });

  it("a symbol in the stats map with no matching instrument row is a silent no-op, not an error", async () => {
    const { fakeDb, getRows } = createFakeDb([seedRow({ exchange: "NSE", symbol: "TCS" })]);

    await expect(
      applyLatestInstrumentStats(
        "NSE",
        new Map([
          ["TCS", stat({ close: 1 })],
          ["DOES_NOT_EXIST", stat({ close: 2 })],
        ]),
        fakeDb as unknown as DbOrTx
      )
    ).resolves.not.toThrow();
    expect(getRows()).toHaveLength(1);
    expect(getRows()[0].latestClose).toBe("1");
  });

  it("empty stats map issues zero statements", async () => {
    const { fakeDb, getExecuteCount } = createFakeDb([seedRow({ exchange: "NSE", symbol: "TCS" })]);

    await applyLatestInstrumentStats("NSE", new Map(), fakeDb as unknown as DbOrTx);

    expect(getExecuteCount()).toBe(0);
  });

  it("chunk boundary: more symbols than the chunk size issues more than one statement, and every row still gets updated", async () => {
    const CHUNK_SIZE = 500; // matches INSTRUMENT_STATS_UPDATE_CHUNK_SIZE
    const symbolCount = CHUNK_SIZE + 1;
    const seedRows = Array.from({ length: symbolCount }, (_, i) => seedRow({ exchange: "NSE", symbol: `SYM${i}` }));
    const { fakeDb, getRows, getExecuteCount } = createFakeDb(seedRows);

    const statsMap = new Map(
      Array.from({ length: symbolCount }, (_, i) => [`SYM${i}`, stat({ close: i })] as const)
    );

    await applyLatestInstrumentStats("NSE", statsMap, fakeDb as unknown as DbOrTx);

    expect(getExecuteCount()).toBe(2); // 500 + 1, split across 2 statements
    expect(getRows().every((r) => r.latestClose !== null)).toBe(true);
    expect(getRows().find((r) => r.symbol === `SYM${symbolCount - 1}`)?.latestClose).toBe(
      String(symbolCount - 1)
    );
  });
});
