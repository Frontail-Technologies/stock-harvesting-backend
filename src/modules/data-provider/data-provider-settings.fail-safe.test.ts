import { describe, expect, it } from "vitest";

import { getProviderPriority, isProviderEnabled } from "./data-provider-settings.service";

// No Postgres is reachable in this test environment (confirmed project-wide
// constraint - see market-data.backfill-atomicity.test.ts), so every DB call
// here genuinely fails. That's exactly the scenario this regression test
// needs: a caller with no working data_provider_settings table at all
// (matches both "DB is down" and "migration hasn't run yet" in production).
//
// This is a direct regression test for a real incident: isProviderEnabled
// was originally called unguarded from listSupportedExchanges (an unrelated,
// widely-used endpoint), and because the underlying read threw instead of
// being caught, it took down GET /api/market-data/exchanges entirely the
// moment this feature shipped ahead of its own migration. These assertions
// must resolve, not throw or hang, and must fail OPEN (preserve pre-feature
// behavior) rather than silently disabling every provider.
describe("data-provider-settings fail-safe behavior (no reachable DB)", () => {
  it("isProviderEnabled resolves true instead of throwing when the settings table can't be read", async () => {
    await expect(isProviderEnabled("zerodha")).resolves.toBe(true);
    await expect(isProviderEnabled("global-datafeeds")).resolves.toBe(true);
    await expect(isProviderEnabled("eodhd")).resolves.toBe(true);
    await expect(isProviderEnabled("some-unknown-key")).resolves.toBe(true);
  });

  it("getProviderPriority resolves a default instead of throwing when the settings table can't be read", async () => {
    await expect(getProviderPriority("zerodha")).resolves.toBe(100);
  });
});
