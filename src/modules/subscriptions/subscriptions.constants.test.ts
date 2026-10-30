import { describe, expect, it } from "vitest";

import { SUBSCRIPTION_CATALOG, SUBSCRIPTION_GRACE_MS } from "./subscriptions.constants";

describe("subscription catalog", () => {
  it("keeps the approved GST-inclusive prices and cycles", () => {
    expect(SUBSCRIPTION_CATALOG.map(({ intervalMonths, amountPaise }) => ({ intervalMonths, amountPaise }))).toEqual([
      { intervalMonths: 1, amountPaise: 59_900 },
      { intervalMonths: 3, amountPaise: 165_000 },
      { intervalMonths: 6, amountPaise: 300_000 },
      { intervalMonths: 12, amountPaise: 550_000 },
    ]);
  });

  it("uses a three-day failed-payment grace period", () => {
    expect(SUBSCRIPTION_GRACE_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });
});
