import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
const resolveEligibleProviders = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        groupBy: () => chain,
        then: (resolve: (value: unknown[]) => void) => Promise.resolve(selectRows()).then(resolve),
      };
      return chain;
    },
  },
}));
vi.mock("../data-provider/data-provider.service", () => ({ resolveEligibleProviders }));

import {
  activeUniverseFilter,
  listInstrumentSyncExchanges,
  listProductionExchanges,
  productionProviderKeyForExchange,
} from "./market-data.universe";

function eligibleFor(...exchanges: string[]) {
  resolveEligibleProviders.mockImplementation(async ({ exchange }: { exchange: string }) =>
    exchanges.includes(exchange) ? [{ providerKey: "any" }] : []
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("productionProviderKeyForExchange", () => {
  it("maps BSE and BSE_IDX to GlobalDataFeeds and retired NSE/NSE_IDX to no provider", () => {
    expect(productionProviderKeyForExchange("BSE")).toBe("global-datafeeds");
    expect(productionProviderKeyForExchange("BSE_IDX")).toBe("global-datafeeds");
    expect(productionProviderKeyForExchange("NSE")).toBeNull();
    expect(productionProviderKeyForExchange("NSE_IDX")).toBeNull();
  });
});

describe("activeUniverseFilter", () => {
  it("matches nothing for a retired exchange, whatever rows exist in the DB", () => {
    const filter = activeUniverseFilter("NSE") as unknown as { queryChunks: Array<{ value?: string[] }> };
    const text = filter.queryChunks.map((chunk) => chunk.value?.join("") ?? "").join("");
    expect(text).toContain("false");
  });
});

describe("listProductionExchanges", () => {
  it("returns only exchanges with active instruments stamped with their own production provider and a live provider", async () => {
    selectRows.mockReturnValue([
      { exchange: "BSE", provider: "global-datafeeds" },
      { exchange: "BSE_IDX", provider: "global-datafeeds" },
    ]);
    eligibleFor("BSE", "BSE_IDX");

    await expect(listProductionExchanges()).resolves.toEqual(["BSE", "BSE_IDX"]);
  });

  it("never returns a retired exchange even if legacy active rows still exist for it", async () => {
    selectRows.mockReturnValue([
      { exchange: "NSE", provider: "zerodha" },
      { exchange: "NSE_IDX", provider: "zerodha" },
      { exchange: "BSE", provider: "global-datafeeds" },
    ]);
    eligibleFor("NSE", "NSE_IDX", "BSE");

    await expect(listProductionExchanges()).resolves.toEqual(["BSE"]);
  });

  it("ignores rows whose stored provider is not the exchange's production provider", async () => {
    selectRows.mockReturnValue([{ exchange: "BSE", provider: "eodhd" }]);
    eligibleFor("BSE");

    await expect(listProductionExchanges()).resolves.toEqual([]);
  });

  it("skips an exchange whose provider is disabled or unconfigured", async () => {
    selectRows.mockReturnValue([
      { exchange: "BSE", provider: "global-datafeeds" },
      { exchange: "US", provider: "eodhd" },
    ]);
    eligibleFor("BSE");

    await expect(listProductionExchanges()).resolves.toEqual(["BSE"]);
  });

  it("returns nothing when there are no active instruments at all", async () => {
    selectRows.mockReturnValue([]);
    eligibleFor("BSE", "BSE_IDX");

    await expect(listProductionExchanges()).resolves.toEqual([]);
  });
});

describe("listInstrumentSyncExchanges", () => {
  it("adds GlobalDataFeeds-configured exchanges that have no instruments yet, so discovery can run", async () => {
    selectRows.mockReturnValue([]);
    eligibleFor("BSE", "BSE_IDX");

    await expect(listInstrumentSyncExchanges()).resolves.toEqual(["BSE", "BSE_IDX"]);
  });

  it("adds nothing while the provider is not live", async () => {
    selectRows.mockReturnValue([]);
    eligibleFor();

    await expect(listInstrumentSyncExchanges()).resolves.toEqual([]);
  });
});
