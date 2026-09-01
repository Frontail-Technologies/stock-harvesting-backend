import { describe, expect, it } from "vitest";

import {
  selectApplicableVersion,
  type CollectionVersionEffectiveFromRow,
} from "./market-collection-versions.service";

// Regression coverage for the point-in-time membership resolver (see
// docs/REGRESSION_RULES.md rule 10/11: historical membership must resolve
// point-in-time, never blend with current membership). Does not change
// membership semantics - only proves the current selection logic.
describe("selectApplicableVersion", () => {
  const versionA: CollectionVersionEffectiveFromRow = { id: "version-a", effectiveFrom: "2024-01-05" };
  const versionB: CollectionVersionEffectiveFromRow = { id: "version-b", effectiveFrom: "2024-06-14" };
  const versions = [versionA, versionB];

  it("resolves to version A for a week strictly before version B's effective date", () => {
    const result = selectApplicableVersion(versions, "2024-06-07");
    expect(result?.id).toBe("version-a");
  });

  it("resolves to version B on the exact week version B becomes effective", () => {
    const result = selectApplicableVersion(versions, "2024-06-14");
    expect(result?.id).toBe("version-b");
  });

  it("resolves to version B for a week after version B's effective date", () => {
    const result = selectApplicableVersion(versions, "2025-01-01");
    expect(result?.id).toBe("version-b");
  });

  it("returns null for a date before the first version's effective date (does not fall back to any version)", () => {
    const result = selectApplicableVersion(versions, "2023-12-31");
    expect(result).toBeNull();
  });

  it("returns null for an empty version list", () => {
    expect(selectApplicableVersion([], "2024-06-14")).toBeNull();
  });

  it("is unaffected by input ordering - the same answer regardless of which order versions are passed in", () => {
    const reversed = [versionB, versionA];
    expect(selectApplicableVersion(reversed, "2024-06-07")?.id).toBe("version-a");
    expect(selectApplicableVersion(reversed, "2025-01-01")?.id).toBe("version-b");
  });

  it("with three versions, never skips over the correct one to an older or newer version (no blending of historical periods)", () => {
    const versionC: CollectionVersionEffectiveFromRow = { id: "version-c", effectiveFrom: "2025-03-01" };
    const three = [versionA, versionB, versionC];

    // Squarely inside version B's window - must be B, not A (too old) or C (too new).
    expect(selectApplicableVersion(three, "2024-09-01")?.id).toBe("version-b");
    // Squarely inside version C's window.
    expect(selectApplicableVersion(three, "2025-06-01")?.id).toBe("version-c");
    // Squarely inside version A's window.
    expect(selectApplicableVersion(three, "2024-03-01")?.id).toBe("version-a");
  });
});
