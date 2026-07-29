import { describe, expect, it } from "vitest";

import { decryptField, encryptField } from "./encryption";

describe("field encryption", () => {
  it("round trips encrypted values without storing plaintext", () => {
    const encrypted = encryptField("sensitive-token");

    expect(encrypted.ciphertext).not.toContain("sensitive-token");
    expect(decryptField(encrypted)).toBe("sensitive-token");
  });
});
