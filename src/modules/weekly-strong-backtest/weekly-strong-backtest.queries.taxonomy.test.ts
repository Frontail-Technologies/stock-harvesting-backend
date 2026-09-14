import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn() } }));
vi.mock("../market-collections/market-collections.service", () => ({
  requireCollectionByCode: vi.fn(),
}));

import * as dbClientModule from "../../db/client";
import { instruments } from "../../db/schema";
import * as collectionsServiceModule from "../market-collections/market-collections.service";
import { UNCLASSIFIED_SECTOR_LABEL } from "./weekly-strong-backtest.constants";
import { getWeeklyStrongBacktestStacked } from "./weekly-strong-backtest.queries";

const db = vi.mocked(dbClientModule.db);
const requireCollectionByCode = vi.mocked(collectionsServiceModule.requireCollectionByCode);

// Chain that records how it was built and resolves to `rows` when awaited.
function chain(rows: unknown[], joins?: unknown[]) {
  const c: Record<string, unknown> = {};
  const passthrough = () => c;
  c.from = passthrough;
  c.where = passthrough;
  c.orderBy = passthrough;
  c.limit = passthrough;
  c.groupBy = passthrough;
  c.innerJoin = (table: unknown) => {
    joins?.push(table);
    return c;
  };
  c.then = (resolve: (v: unknown[]) => void, reject: (e?: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return c as never;
}

describe("getWeeklyStrongBacktestStacked - taxonomy fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCollectionByCode.mockResolvedValue({ id: "col-1", code: "BSE100", name: "BSE 100" } as never);
  });

  it("joins instruments (for the live-sector fallback) and still labels genuinely-null sectors Unclassified", async () => {
    const joins: unknown[] = [];
    db.select
      // selectPreferredRuns: no historical runs...
      .mockReturnValueOnce(chain([]))
      // ...one current-membership run
      .mockReturnValueOnce(chain([{ id: "run-1", weekEnding: "2026-08-31", totalPassing: 3 }]))
      // the sector rollup (post-COALESCE rows, as Postgres would return them:
      // the frozen-null-but-live-classified member resolves to its live
      // sector; the frozen-AND-live-null member comes back as null)
      .mockReturnValueOnce(
        chain(
          [
            { runId: "run-1", sector: "Information Technology", count: 2 },
            { runId: "run-1", sector: null, count: 1 },
          ],
          joins
        )
      );

    const result = await getWeeklyStrongBacktestStacked({ code: "BSE100" });

    expect(joins).toContain(instruments);
    const sectors = result.points[0].sectors.map((s) => s.sector);
    expect(sectors).toContain("Information Technology");
    expect(sectors).toContain(UNCLASSIFIED_SECTOR_LABEL);
    // The all-null run is NOT collapsed entirely to Unclassified when a live
    // classification exists for some members.
    expect(sectors).not.toEqual([UNCLASSIFIED_SECTOR_LABEL]);
  });

  it("returns an empty chart (not an Unclassified-only one) when there are no runs", async () => {
    db.select
      .mockReturnValueOnce(chain([])) // no historical
      .mockReturnValueOnce(chain([])); // no current

    const result = await getWeeklyStrongBacktestStacked({ code: "BSE100" });

    expect(result.generated).toBe(false);
    expect(result.points).toEqual([]);
  });

  it("falls back to current-membership history when historical coverage is shorter", async () => {
    db.select
      .mockReturnValueOnce(chain([{ id: "hist-1", weekEnding: "2026-09-07", totalPassing: 62 }]))
      .mockReturnValueOnce(
        chain([
          { id: "current-3", weekEnding: "2026-09-07", totalPassing: 62 },
          { id: "current-2", weekEnding: "2026-08-31", totalPassing: 58 },
          { id: "current-1", weekEnding: "2026-08-24", totalPassing: 55 },
        ])
      )
      .mockReturnValueOnce(
        chain([
          { runId: "current-1", sector: "Information Technology", count: 55 },
          { runId: "current-2", sector: "Information Technology", count: 58 },
          { runId: "current-3", sector: "Information Technology", count: 62 },
        ])
      );

    const result = await getWeeklyStrongBacktestStacked({ code: "BSE100" });

    expect(result.membershipMode).toBe("current_membership");
    expect(result.points).toHaveLength(3);
    expect(result.points.map((point) => point.total)).toEqual([55, 58, 62]);
  });
});
