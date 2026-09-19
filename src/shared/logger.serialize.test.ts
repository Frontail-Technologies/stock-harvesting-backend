import { describe, expect, it } from "vitest";

import { serializeErrorForLog } from "./logger";

describe("serializeErrorForLog", () => {
  it("caps a huge query error message and stack instead of writing hundreds of KB per line", () => {
    const error = new Error(`Failed query: select ${"$1, ".repeat(100_000)}`);

    const serialized = serializeErrorForLog(error) as { message: string; stack: string };

    expect(serialized.message.length).toBeLessThan(2_100);
    expect(serialized.message).toContain("truncated");
    expect(serialized.stack.length).toBeLessThan(2_100);
  });

  it("caps the cause too", () => {
    const error = new Error("outer", { cause: new Error("x".repeat(50_000)) });

    const serialized = serializeErrorForLog(error) as { cause: { message: string } };

    expect(serialized.cause.message.length).toBeLessThan(2_100);
  });

  it("leaves short errors untouched", () => {
    const serialized = serializeErrorForLog(new Error("boom")) as { message: string; type: string };

    expect(serialized.message).toBe("boom");
    expect(serialized.type).toBe("Error");
  });
});
