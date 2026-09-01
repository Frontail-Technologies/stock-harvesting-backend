import { beforeEach, describe, expect, it, vi } from "vitest";

import * as instrumentsModule from "./market-data.instruments";
import * as providerServiceModule from "../data-provider/data-provider.service";
import { ensureInstrumentsForSymbols } from "./market-data.instrument-sync";

/**
 * No existing test covered this orchestration boundary before this
 * extraction (verified: no test file referenced ensureInstrumentsForSymbols,
 * syncProviderInstrumentSearch, or syncProviderInstruments). Unlike the
 * fake-dbClient pattern used elsewhere in this codebase, these functions
 * have no injectable seam (no dbClient/adapter parameter) - they resolve
 * their provider adapter and instrument-row dependencies via module-level
 * imports. Module mocking (vi.mock) is the correct tool for that shape
 * without redesigning the functions themselves; it changes nothing about
 * production code, only how the test observes calls made during it.
 */

vi.mock("./market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn(),
  createFallbackInstrument: vi.fn(),
  upsertInstruments: vi.fn(),
}));

vi.mock("../data-provider/data-provider.service", () => ({
  getEligibleProviderAdapter: vi.fn(),
  getActiveProviderAccessToken: vi.fn(),
}));

vi.mock("../data-provider/data-provider-settings.service", () => ({
  recordProviderSuccess: vi.fn(),
  recordProviderFailure: vi.fn(),
}));

const getInstrumentsBySymbol = vi.mocked(instrumentsModule.getInstrumentsBySymbol);
const createFallbackInstrument = vi.mocked(instrumentsModule.createFallbackInstrument);
const upsertInstruments = vi.mocked(instrumentsModule.upsertInstruments);
const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureInstrumentsForSymbols", () => {
  it("A. does nothing when every requested symbol already has an instrument row", async () => {
    getInstrumentsBySymbol.mockResolvedValueOnce(
      new Map([
        ["TCS", { id: "i1", symbol: "TCS" } as never],
        ["INFY", { id: "i2", symbol: "INFY" } as never],
      ])
    );

    await ensureInstrumentsForSymbols(["TCS", "INFY"], "NSE");

    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
    expect(createFallbackInstrument).not.toHaveBeenCalled();
    expect(upsertInstruments).not.toHaveBeenCalled();
  });

  it("B. missing symbol resolved via provider search uses the provider-resolved instrument (no fallback creation)", async () => {
    getInstrumentsBySymbol
      .mockResolvedValueOnce(new Map()) // initial lookup: nothing exists yet
      .mockResolvedValueOnce(new Map([["NEWSTOCK", { id: "i3", symbol: "NEWSTOCK" } as never]])); // re-check after search: now exists

    getEligibleProviderAdapter.mockImplementation(async (input: { capability: string }) => {
      if (input.capability === "instrument_search") {
        return {
          providerKey: "eodhd",
          searchInstruments: vi.fn().mockResolvedValue([{ symbol: "NEWSTOCK", name: "New Stock", instrumentToken: "tok-1" }]),
        } as never;
      }
      return undefined as never;
    });

    await ensureInstrumentsForSymbols(["NEWSTOCK"], "NSE");

    expect(upsertInstruments).toHaveBeenCalledTimes(1);
    expect(upsertInstruments).toHaveBeenCalledWith(
      [{ symbol: "NEWSTOCK", name: "New Stock", instrumentToken: "tok-1" }],
      "eodhd"
    );
    // Already resolved by the search - the post-search fallback pass must
    // not additionally try to create a fallback row for the same symbol.
    expect(createFallbackInstrument).not.toHaveBeenCalled();
  });

  it("C. missing symbol + search resolves nothing + fallback allowed creates a fallback instrument", async () => {
    getInstrumentsBySymbol
      .mockResolvedValueOnce(new Map()) // initial lookup: nothing exists
      .mockResolvedValueOnce(new Map([["GHOSTCO", { id: "i4", symbol: "GHOSTCO" } as never]])); // re-check: fallback row now exists

    getEligibleProviderAdapter.mockImplementation(async (input: { capability: string }) => {
      if (input.capability === "instrument_search") {
        return { providerKey: "eodhd", searchInstruments: vi.fn().mockResolvedValue([]) } as never;
      }
      if (input.capability === "instrument_token") {
        return { providerKey: "eodhd", getInstrumentToken: vi.fn().mockResolvedValue("tok-ghost") } as never;
      }
      return undefined as never;
    });

    await ensureInstrumentsForSymbols(["GHOSTCO"], "NSE");

    expect(createFallbackInstrument).toHaveBeenCalledTimes(1);
    expect(createFallbackInstrument).toHaveBeenCalledWith("GHOSTCO", "NSE");
  });

  it("D. missing symbol + fallback not allowed leaves the symbol unresolved without throwing", async () => {
    getInstrumentsBySymbol
      .mockResolvedValueOnce(new Map()) // initial lookup: nothing exists
      .mockResolvedValueOnce(new Map()); // re-check: still nothing (fallback never ran)

    getEligibleProviderAdapter.mockImplementation(async (input: { capability: string }) => {
      if (input.capability === "instrument_search") {
        return { providerKey: "eodhd", searchInstruments: vi.fn().mockResolvedValue([]) } as never;
      }
      if (input.capability === "instrument_token") {
        // No getInstrumentToken capability anywhere -> canCreateFallbackInstrument is false.
        return undefined as never;
      }
      return undefined as never;
    });

    await expect(ensureInstrumentsForSymbols(["ORPHAN"], "NSE")).resolves.not.toThrow();
    expect(createFallbackInstrument).not.toHaveBeenCalled();
  });
});
