export const OAUTH_STATE_TTL_MINUTES = 10;

export const AUTH_PORTALS = ["user", "admin"] as const;
export type AuthPortal = (typeof AUTH_PORTALS)[number];

// The access token's JWT `aud` claim - a second, independent signal from
// `role` that protected routes must also validate (see auth.middleware.ts).
// An admin-portal token and a user-portal token are structurally
// interchangeable except for this claim, so relying on role alone would
// let a leaked/replayed admin token authorize main-app routes (or vice
// versa) for the same underlying account.
export const TOKEN_AUDIENCE: Record<AuthPortal, string> = {
  user: "stock-harvesting-app",
  admin: "stock-harvesting-admin",
};

// Strict portal separation (USER app vs ADMIN console) - see
// security/tokens.ts, security/cookies.ts, and auth.service.ts. Two
// completely distinct cookie names so the browser's cookie jar itself
// can never conflate a user session with an admin session, even though
// both are ultimately issued by the same backend host.
export const USER_REFRESH_COOKIE_NAME = "sh_user_refresh";
export const ADMIN_REFRESH_COOKIE_NAME = "sh_admin_refresh";

export const OAUTH_STATE_COOKIE_NAME = "sh_oauth_state";
// Carries which portal (main site vs admin panel) started the Google OAuth
// round-trip, since Google's own "state" param already carries the CSRF
// token and mixing concerns into it would require parsing/splitting it back
// apart. Same lifetime/handling as the state cookie - set and cleared
// together. IMPORTANT: this cookie is only ever used to pick which
// frontend origin/cookie pair to use for the callback - it is NEVER
// trusted as proof of admin permission. Role/portal authorization is
// always re-decided from the verified Google profile + DB user row in
// auth.service.ts's completeGoogleLogin, which rejects the login outright
// (no session of either kind created) if the resolved account's role
// doesn't match the portal that started the flow.
export const OAUTH_PORTAL_COOKIE_NAME = "sh_oauth_portal";

export const ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const ENCRYPTION_IV_BYTES = 12;
