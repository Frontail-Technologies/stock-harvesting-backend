import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./widget-preferences.repository", () => ({
  findWidgetPreferencesRow: vi.fn(),
  upsertWidgetPreferencesRow: vi.fn(),
  deleteWidgetPreferencesRow: vi.fn(),
}));

import * as repository from "./widget-preferences.repository";
import type { WidgetPreferenceSource } from "../../db/schema";
import { clearWidgetPreferences, getWidgetPreferences, saveWidgetPreferences } from "./widget-preferences.service";

const findWidgetPreferencesRow = vi.mocked(repository.findWidgetPreferencesRow);
const upsertWidgetPreferencesRow = vi.mocked(repository.upsertWidgetPreferencesRow);
const deleteWidgetPreferencesRow = vi.mocked(repository.deleteWidgetPreferencesRow);

beforeEach(() => vi.clearAllMocks());

describe("getWidgetPreferences", () => {
  it("no saved row -> hasSavedPreference: false, distinct from an empty saved selection", async () => {
    findWidgetPreferencesRow.mockResolvedValueOnce(undefined);

    const result = await getWidgetPreferences("user-1");

    expect(result).toEqual({ hasSavedPreference: false, sources: [] });
  });

  it("a saved row with sources: [] is still a real, deliberate preference, not treated as unset", async () => {
    findWidgetPreferencesRow.mockResolvedValueOnce({ sources: [] });

    const result = await getWidgetPreferences("user-1");

    expect(result).toEqual({ hasSavedPreference: true, sources: [] });
  });

  it("returns the saved sources in their stored order", async () => {
    const sources: WidgetPreferenceSource[] = [
      { type: "segment", id: "seg-1" },
      { type: "watchlist", id: "wl-1" },
    ];
    findWidgetPreferencesRow.mockResolvedValueOnce({ sources });

    const result = await getWidgetPreferences("user-1");

    expect(result).toEqual({ hasSavedPreference: true, sources });
  });
});

describe("saveWidgetPreferences", () => {
  it("delegates to the repository and passes its result through", async () => {
    const sources: WidgetPreferenceSource[] = [{ type: "segment", id: "seg-1" }];
    upsertWidgetPreferencesRow.mockResolvedValueOnce({ sources });

    const result = await saveWidgetPreferences("user-1", sources);

    expect(upsertWidgetPreferencesRow).toHaveBeenCalledWith("user-1", sources);
    expect(result).toEqual({ sources });
  });

  it("saving an empty array is passed through as-is (a deliberate zero-selection choice)", async () => {
    upsertWidgetPreferencesRow.mockResolvedValueOnce({ sources: [] });

    const result = await saveWidgetPreferences("user-1", []);

    expect(upsertWidgetPreferencesRow).toHaveBeenCalledWith("user-1", []);
    expect(result).toEqual({ sources: [] });
  });
});

describe("clearWidgetPreferences", () => {
  it("deletes the user's row, reverting them back to 'no saved preference'", async () => {
    deleteWidgetPreferencesRow.mockResolvedValueOnce(undefined);

    const result = await clearWidgetPreferences("user-1");

    expect(deleteWidgetPreferencesRow).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({ ok: true });
  });
});
