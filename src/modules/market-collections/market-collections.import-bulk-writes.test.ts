import { describe, expect, it } from "vitest";

import type { DbOrTx } from "../../db/client";
import { deactivateCollectionMembers, upsertMatchedCollectionMembers } from "./market-collections.service";

/**
 * No Postgres instance is reachable in this environment (same constraint as
 * market-data.backfill-atomicity.test.ts). What this proves: given the exact
 * bulk insert/update calls upsertMatchedCollectionMembers and
 * deactivateCollectionMembers issue, simulating real Postgres semantics for
 * them (upsert on the (collectionId, instrumentId) conflict target, update
 * only rows matching both collectionId and instrumentId) produces the same
 * final membership state the old one-write-per-row loop would have — a
 * behavior/state test against a fake tx, not a SQL-string comparison. The
 * `where(...)` condition is a real Drizzle `and(eq(...), inArray(...))`
 * object, walked via its own queryChunks the same way
 * market-data.instrument-stats-bulk-update.test.ts walks a `sql` template,
 * rather than trusted blindly.
 */

type FakeMemberRow = {
  collectionId: string;
  instrumentId: string;
  active: boolean;
  updatedAt: string;
};

function flattenQuery(query: unknown, out: Array<{ type: "text" | "param"; value: unknown }> = []) {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      flattenQuery(chunk, out);
    } else if (
      chunk &&
      typeof chunk === "object" &&
      "value" in chunk &&
      Array.isArray((chunk as { value: unknown }).value) &&
      typeof (chunk as { value: unknown[] }).value[0] === "string"
    ) {
      out.push({ type: "text", value: (chunk as { value: string[] }).value.join("") });
    } else {
      out.push({ type: "param", value: chunk });
    }
  }
  return out;
}

// Extracts { collectionId, instrumentIds } from a real
// `and(eq(marketCollectionMembers.collectionId, x), inArray(marketCollectionMembers.instrumentId, [...]))`
// condition, by position: [column, Param, column, Param[]] in that order —
// verified empirically (see the diagnostic exploration this was built from)
// against exactly the condition shape deactivateCollectionMembers builds.
function extractDeactivateCondition(condition: unknown): { collectionId: string; instrumentIds: string[] } {
  const params = flattenQuery(condition)
    .filter((s) => s.type === "param")
    .map((s) => s.value as { name?: string; value?: unknown } | Array<{ value: unknown }>);

  const eqValue = params[1] as { value: string };
  const inValues = params[3] as Array<{ value: string }>;
  return { collectionId: eqValue.value, instrumentIds: inValues.map((p) => p.value) };
}

function createFakeTx(seedRows: FakeMemberRow[]) {
  const rows = [...seedRows];
  let insertCallCount = 0;
  let updateCallCount = 0;

  const tx = {
    insert: (_table: unknown) => ({
      values: (newRows: Array<{ collectionId: string; instrumentId: string; active: boolean }>) => ({
        onConflictDoUpdate: async (_options: unknown) => {
          insertCallCount++;
          for (const row of newRows) {
            const existing = rows.find(
              (r) => r.collectionId === row.collectionId && r.instrumentId === row.instrumentId
            );
            if (existing) {
              existing.active = true;
              existing.updatedAt = "now()";
            } else {
              rows.push({
                collectionId: row.collectionId,
                instrumentId: row.instrumentId,
                active: true,
                updatedAt: "now()",
              });
            }
          }
        },
      }),
    }),
    update: (_table: unknown) => ({
      set: (_changes: { active: boolean }) => ({
        where: async (condition: unknown) => {
          updateCallCount++;
          const { collectionId, instrumentIds } = extractDeactivateCondition(condition);
          for (const row of rows) {
            if (row.collectionId === collectionId && instrumentIds.includes(row.instrumentId)) {
              row.active = false;
              row.updatedAt = "now()";
            }
          }
        },
      }),
    }),
  };

  return {
    tx,
    getRows: () => rows,
    getInsertCallCount: () => insertCallCount,
    getUpdateCallCount: () => updateCallCount,
  };
}

function seedRow(overrides: Partial<FakeMemberRow> & { collectionId: string; instrumentId: string }): FakeMemberRow {
  return { active: false, updatedAt: "2020-01-01T00:00:00Z", ...overrides };
}

describe("upsertMatchedCollectionMembers", () => {
  it("activates new and reactivated matched rows, skips already-active rows entirely", async () => {
    const { tx, getRows, getInsertCallCount } = createFakeTx([
      seedRow({ collectionId: "c1", instrumentId: "i-already", active: true }),
    ]);

    await upsertMatchedCollectionMembers(tx as unknown as DbOrTx, "c1", [
      { instrumentId: "i-new", status: "new" },
      { instrumentId: "i-reactivate", status: "reactivate" },
      { instrumentId: "i-already", status: "already-active" },
    ]);

    // Only 1 statement for 2 rows to write — already-active is excluded
    // from the write entirely, matching the old loop's `continue`.
    expect(getInsertCallCount()).toBe(1);
    const rows = getRows();
    expect(rows.find((r) => r.instrumentId === "i-new")?.active).toBe(true);
    expect(rows.find((r) => r.instrumentId === "i-reactivate")?.active).toBe(true);
    expect(rows.find((r) => r.instrumentId === "i-already")?.active).toBe(true);
  });

  it("empty matched list issues zero statements", async () => {
    const { tx, getInsertCallCount } = createFakeTx([]);
    await upsertMatchedCollectionMembers(tx as unknown as DbOrTx, "c1", []);
    expect(getInsertCallCount()).toBe(0);
  });

  it("all-already-active input issues zero statements", async () => {
    const { tx, getInsertCallCount } = createFakeTx([]);
    await upsertMatchedCollectionMembers(tx as unknown as DbOrTx, "c1", [
      { instrumentId: "i1", status: "already-active" },
      { instrumentId: "i2", status: "already-active" },
    ]);
    expect(getInsertCallCount()).toBe(0);
  });

  it("chunk boundary: more rows than the chunk size issues more than one statement, and every row is still written", async () => {
    const CHUNK_SIZE = 500;
    const rowCount = CHUNK_SIZE + 1;
    const { tx, getRows, getInsertCallCount } = createFakeTx([]);

    const matched = Array.from({ length: rowCount }, (_, i) => ({
      instrumentId: `i${i}`,
      status: "new" as const,
    }));

    await upsertMatchedCollectionMembers(tx as unknown as DbOrTx, "c1", matched);

    expect(getInsertCallCount()).toBe(2); // 500 + 1
    expect(getRows()).toHaveLength(rowCount);
    expect(getRows().every((r) => r.active)).toBe(true);
  });
});

describe("deactivateCollectionMembers", () => {
  it("deactivates every listed instrument for the given collection", async () => {
    const { tx, getRows, getUpdateCallCount } = createFakeTx([
      seedRow({ collectionId: "c1", instrumentId: "i1", active: true }),
      seedRow({ collectionId: "c1", instrumentId: "i2", active: true }),
      seedRow({ collectionId: "c1", instrumentId: "i3", active: true }),
    ]);

    await deactivateCollectionMembers(tx as unknown as DbOrTx, "c1", ["i1", "i2"]);

    expect(getUpdateCallCount()).toBe(1);
    const rows = getRows();
    expect(rows.find((r) => r.instrumentId === "i1")?.active).toBe(false);
    expect(rows.find((r) => r.instrumentId === "i2")?.active).toBe(false);
    expect(rows.find((r) => r.instrumentId === "i3")?.active).toBe(true);
  });

  it("never cross-affects the same instrumentId on a different collection", async () => {
    const { tx, getRows } = createFakeTx([
      seedRow({ collectionId: "c1", instrumentId: "shared", active: true }),
      seedRow({ collectionId: "c2", instrumentId: "shared", active: true }),
    ]);

    await deactivateCollectionMembers(tx as unknown as DbOrTx, "c1", ["shared"]);

    const rows = getRows();
    expect(rows.find((r) => r.collectionId === "c1")?.active).toBe(false);
    expect(rows.find((r) => r.collectionId === "c2")?.active).toBe(true);
  });

  it("empty instrumentId list issues zero statements", async () => {
    const { tx, getUpdateCallCount } = createFakeTx([seedRow({ collectionId: "c1", instrumentId: "i1", active: true })]);
    await deactivateCollectionMembers(tx as unknown as DbOrTx, "c1", []);
    expect(getUpdateCallCount()).toBe(0);
  });

  it("chunk boundary: more instrumentIds than the chunk size issues more than one statement, and every row is still deactivated", async () => {
    const CHUNK_SIZE = 500;
    const idCount = CHUNK_SIZE + 1;
    const seedRows = Array.from({ length: idCount }, (_, i) => seedRow({ collectionId: "c1", instrumentId: `i${i}`, active: true }));
    const { tx, getRows, getUpdateCallCount } = createFakeTx(seedRows);

    const instrumentIds = Array.from({ length: idCount }, (_, i) => `i${i}`);
    await deactivateCollectionMembers(tx as unknown as DbOrTx, "c1", instrumentIds);

    expect(getUpdateCallCount()).toBe(2); // 500 + 1
    expect(getRows().every((r) => r.active === false)).toBe(true);
  });
});
