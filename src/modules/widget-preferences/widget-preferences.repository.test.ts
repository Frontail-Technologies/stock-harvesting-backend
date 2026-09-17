import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() } }));

import * as dbClientModule from "../../db/client";
import type { WidgetPreferenceSource } from "../../db/schema";
import {
  deleteWidgetPreferencesRow,
  findWidgetPreferencesRow,
  upsertWidgetPreferencesRow,
} from "./widget-preferences.repository";

const db = vi.mocked(dbClientModule.db);

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

describe("findWidgetPreferencesRow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no saved row -> returns undefined", async () => {
    db.select.mockReturnValueOnce(selectResult([]) as never);

    const result = await findWidgetPreferencesRow("user-1");

    expect(result).toBeUndefined();
  });

  it("a saved row with sources: [] is returned as-is, not treated as absent", async () => {
    db.select.mockReturnValueOnce(selectResult([{ sources: [] }]) as never);

    const result = await findWidgetPreferencesRow("user-1");

    expect(result).toEqual({ sources: [] });
  });

  it("returns the saved sources in their stored order", async () => {
    const sources = [
      { type: "segment", id: "seg-1" },
      { type: "watchlist", id: "wl-1" },
    ];
    db.select.mockReturnValueOnce(selectResult([{ sources }]) as never);

    const result = await findWidgetPreferencesRow("user-1");

    expect(result).toEqual({ sources });
  });
});

describe("upsertWidgetPreferencesRow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts on the user's unique row via onConflictDoUpdate, not a plain insert", async () => {
    const sources: WidgetPreferenceSource[] = [{ type: "segment", id: "seg-1" }];
    const returning = vi.fn(async () => [{ sources }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    db.insert.mockReturnValueOnce({ values } as never);

    const result = await upsertWidgetPreferencesRow("user-1", sources);

    expect(values).toHaveBeenCalledWith({ userId: "user-1", sources });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sources });
  });

  it("saving an empty array persists it as-is (a deliberate zero-selection choice)", async () => {
    const returning = vi.fn(async () => [{ sources: [] }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    db.insert.mockReturnValueOnce({ values } as never);

    const result = await upsertWidgetPreferencesRow("user-1", []);

    expect(values).toHaveBeenCalledWith({ userId: "user-1", sources: [] });
    expect(result).toEqual({ sources: [] });
  });
});

describe("deleteWidgetPreferencesRow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the user's row", async () => {
    const where = vi.fn(async () => undefined);
    db.delete.mockReturnValueOnce({ where } as never);

    await deleteWidgetPreferencesRow("user-1");

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
