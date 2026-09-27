import { describe, expect, it } from "vitest";

import { JOB_NAMES } from "../../shared/constants";
import { getJobRuntimeLimitMs } from "./job-runtime-limits";

describe("getJobRuntimeLimitMs", () => {
  it("bounds interactive chart repair jobs well below bulk sync jobs", () => {
    expect(getJobRuntimeLimitMs(JOB_NAMES.chartCandleEnsureFresh)).toBe(15 * 60_000);
    expect(getJobRuntimeLimitMs(JOB_NAMES.dailyCandleSync)).toBe(8 * 60 * 60_000);
  });

  it("gives unknown jobs a finite fallback", () => {
    expect(getJobRuntimeLimitMs("unknown-job")).toBe(2 * 60 * 60_000);
  });
});
