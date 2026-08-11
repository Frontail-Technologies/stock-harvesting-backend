import { describe, expect, it } from "vitest";

import { dedupeInstrumentUpsertInputs } from "./market-data.service";

describe("dedupeInstrumentUpsertInputs", () => {
  it("passes through a batch with no duplicates unchanged", () => {
    const input = [
      { exchange: "NSE", symbol: "RELIANCE", name: "Reliance", instrumentToken: "101" },
      { exchange: "NSE", symbol: "TCS", name: "TCS", instrumentToken: "102" },
    ];

    expect(dedupeInstrumentUpsertInputs(input)).toEqual(input);
  });

  it("resolves duplicate exchange+symbol by keeping the later row", () => {
    const stale = { exchange: "NSE", symbol: "RELIANCE", name: "Reliance Old", instrumentToken: "101" };
    const fresh = { exchange: "NSE", symbol: "RELIANCE", name: "Reliance Industries", instrumentToken: "999" };

    const result = dedupeInstrumentUpsertInputs([stale, fresh]);

    expect(result).toEqual([fresh]);
  });

  it("treats symbol duplicates as case/whitespace-insensitive via normalizeSymbol", () => {
    const first = { exchange: "NSE", symbol: " reliance ", name: "First", instrumentToken: "101" };
    const second = { exchange: "NSE", symbol: "RELIANCE", name: "Second", instrumentToken: "102" };

    const result = dedupeInstrumentUpsertInputs([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Second");
  });

  it("resolves duplicate (provider-scoped) instrument tokens across different symbols by keeping the later row", () => {
    const first = { exchange: "NSE", symbol: "AAA", name: "AAA Ltd", instrumentToken: "555" };
    const second = { exchange: "NSE", symbol: "BBB", name: "BBB Ltd", instrumentToken: "555" };

    const result = dedupeInstrumentUpsertInputs([first, second]);

    expect(result).toEqual([second]);
  });

  it("does not let an exchange+symbol collision hide behind an unrelated token collision", () => {
    // AAA appears twice (exchange+symbol collision, later wins) and its
    // survivor then collides on token with BBB (token collision, later
    // wins) — the two dedup passes should compose, leaving exactly one row.
    const input = [
      { exchange: "NSE", symbol: "AAA", name: "AAA v1", instrumentToken: "1" },
      { exchange: "NSE", symbol: "AAA", name: "AAA v2", instrumentToken: "2" },
      { exchange: "NSE", symbol: "BBB", name: "BBB", instrumentToken: "2" },
    ];

    const result = dedupeInstrumentUpsertInputs(input);

    expect(result).toEqual([{ exchange: "NSE", symbol: "BBB", name: "BBB", instrumentToken: "2" }]);
  });

  it("returns an empty array for an empty batch", () => {
    expect(dedupeInstrumentUpsertInputs([])).toEqual([]);
  });
});
