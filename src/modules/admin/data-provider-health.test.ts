import { describe, expect, it } from "vitest";

import { deriveDataProviderHealth } from "./admin.service";

// enabled (admin decision) and health (system observation) are deliberately
// separate concepts - these tests exercise the health derivation in
// isolation from the enabled flag it reads, confirming e.g. that
// enabled=true + a recent failure reports "error" without ever touching
// the stored enabled value itself.
describe("deriveDataProviderHealth", () => {
  it("is 'disabled' whenever enabled is false, regardless of success/failure history", () => {
    expect(
      deriveDataProviderHealth({ enabled: false, lastSuccessAt: new Date(), lastFailureAt: null })
    ).toBe("disabled");
    expect(
      deriveDataProviderHealth({ enabled: false, lastSuccessAt: null, lastFailureAt: new Date() })
    ).toBe("disabled");
  });

  it("is 'unknown' when enabled but no success or failure has ever been recorded", () => {
    expect(
      deriveDataProviderHealth({ enabled: true, lastSuccessAt: null, lastFailureAt: null })
    ).toBe("unknown");
  });

  it("is 'healthy' when the most recent event was a success", () => {
    const earlier = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-02T00:00:00Z");
    expect(
      deriveDataProviderHealth({ enabled: true, lastSuccessAt: later, lastFailureAt: earlier })
    ).toBe("healthy");
  });

  it("is 'healthy' when only a success has ever been recorded", () => {
    expect(
      deriveDataProviderHealth({ enabled: true, lastSuccessAt: new Date(), lastFailureAt: null })
    ).toBe("healthy");
  });

  it("is 'error' when the most recent event was a failure", () => {
    const earlier = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-02T00:00:00Z");
    expect(
      deriveDataProviderHealth({ enabled: true, lastSuccessAt: earlier, lastFailureAt: later })
    ).toBe("error");
  });

  it("is 'error' when only a failure has ever been recorded", () => {
    expect(
      deriveDataProviderHealth({ enabled: true, lastSuccessAt: null, lastFailureAt: new Date() })
    ).toBe("error");
  });

  it("treats a simultaneous success and failure timestamp as an error (ties go to the more cautious state)", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(
      deriveDataProviderHealth({ enabled: true, lastSuccessAt: at, lastFailureAt: at })
    ).toBe("error");
  });
});
