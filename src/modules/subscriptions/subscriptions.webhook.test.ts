import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";

import { verifyRazorpayWebhook } from "./subscriptions.webhook";

describe("verifyRazorpayWebhook", () => {
  const secret = "a-test-webhook-secret";
  const body = Buffer.from('{"event":"subscription.activated"}');

  it("accepts the HMAC of the exact raw request bytes", () => {
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyRazorpayWebhook(body, signature, secret)).toBe(true);
  });

  it("rejects malformed and tampered signatures", () => {
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyRazorpayWebhook(Buffer.from(`${body.toString()} `), signature, secret)).toBe(false);
    expect(verifyRazorpayWebhook(body, "not-a-signature", secret)).toBe(false);
  });
});
