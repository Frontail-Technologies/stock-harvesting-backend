import { describe, expect, it } from "vitest";

import { serializeError } from "./serialize-error";

// Regression: worker.on("failed") logged `"error": {}` because pino does not
// serialize a bare Error passed under a non-`err` key (name/message/stack are
// non-enumerable). serializeError must always yield a populated plain object.

describe("serializeError", () => {
  it("extracts name and message from a plain Error (never an empty object)", () => {
    const result = serializeError(new Error("boom"));
    expect(result).toEqual({ name: "Error", message: "boom" });
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("includes a string/number `code` when present (undici/pg style)", () => {
    const err = Object.assign(new Error("socket died"), { code: "ECONNRESET" });
    expect(serializeError(err)).toMatchObject({ name: "Error", message: "socket died", code: "ECONNRESET" });
  });

  it("includes a shallow cause with its own name/message/code", () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(serializeError(err)).toEqual({
      name: "TypeError",
      message: "fetch failed",
      cause: { name: "Error", message: "other side closed", code: "UND_ERR_SOCKET" },
    });
  });

  it("handles a non-Error thrown value", () => {
    expect(serializeError("just a string")).toEqual({ name: "NonError", message: "just a string" });
    expect(serializeError(42)).toEqual({ name: "NonError", message: "42" });
  });

  it("truncates a very long message", () => {
    const result = serializeError(new Error("x".repeat(5000)));
    expect(result.message.length).toBe(1000);
  });

  it("does not carry arbitrary enumerable props (only name/message/code/cause)", () => {
    const err = Object.assign(new Error("nope"), {
      accessToken: "SECRET-TOKEN",
      requestHeaders: { authorization: "Bearer SECRET" },
    });
    const result = serializeError(err);
    expect(Object.keys(result).sort()).toEqual(["message", "name"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
