import { describe, expect, it } from "vitest";

import { TOKEN_AUDIENCE } from "../../shared/constants";
import { signAccessToken, verifyAccessToken } from "./tokens";

const USER_PAYLOAD = {
  sub: "user-id",
  email: "user@example.com",
  role: "user" as const,
  plan: "free" as const,
  portal: "user" as const,
};

const ADMIN_PAYLOAD = {
  sub: "admin-id",
  email: "admin@example.com",
  role: "admin" as const,
  plan: "free" as const,
  portal: "admin" as const,
};

// Strict portal separation (items 7/8/E/F/G/H) - the access token's `aud`
// claim is a second, independent signal from `role` that requireAuth/
// requireAdminAuth validate. This is the token-layer guarantee that a
// user-portal token can never authorize an admin-portal request, and vice
// versa, regardless of what role happens to be embedded in it.
describe("verifyAccessToken - portal audience validation", () => {
  it("a user-portal token verifies successfully against the user audience", () => {
    const token = signAccessToken(USER_PAYLOAD, 900);
    const payload = verifyAccessToken(token, TOKEN_AUDIENCE.user);
    expect(payload).toEqual(USER_PAYLOAD);
  });

  it("an admin-portal token verifies successfully against the admin audience", () => {
    const token = signAccessToken(ADMIN_PAYLOAD, 600);
    const payload = verifyAccessToken(token, TOKEN_AUDIENCE.admin);
    expect(payload).toEqual(ADMIN_PAYLOAD);
  });

  it("E: a user-portal token is rejected against the admin audience, even for an admin-role account", () => {
    // Shouldn't be issuable post-login-enforcement, but this proves the
    // token layer itself would still reject it if one ever existed.
    const adminRoleUserPortalToken = signAccessToken(
      { ...ADMIN_PAYLOAD, portal: "user" },
      900
    );
    expect(() => verifyAccessToken(adminRoleUserPortalToken, TOKEN_AUDIENCE.admin)).toThrow();
  });

  it("F: an admin-portal token is rejected against the user audience", () => {
    const token = signAccessToken(ADMIN_PAYLOAD, 600);
    expect(() => verifyAccessToken(token, TOKEN_AUDIENCE.user)).toThrow();
  });

  it("rejects an expired token regardless of audience match", () => {
    const token = signAccessToken(USER_PAYLOAD, -1);
    expect(() => verifyAccessToken(token, TOKEN_AUDIENCE.user)).toThrow();
  });

  it("rejects a malformed token", () => {
    expect(() => verifyAccessToken("not-a-real-token", TOKEN_AUDIENCE.user)).toThrow();
  });
});
