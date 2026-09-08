export const OAUTH_STATE_TTL_MINUTES = 10;

export const AUTH_PORTALS = ["user", "admin"] as const;
export type AuthPortal = (typeof AUTH_PORTALS)[number];

// The access token's JWT `aud` claim - a second, independent signal from `role` that protected routes must also validate (see auth.middleware.ts), since an admin/user-portal token is structurally interchangeable except for this claim.
export const TOKEN_AUDIENCE: Record<AuthPortal, string> = {
  user: "stock-harvesting-app",
  admin: "stock-harvesting-admin",
};

// Strict portal separation (USER app vs ADMIN console) - see security/tokens.ts, security/cookies.ts, auth/session.service.ts; two distinct cookie names so the browser's cookie jar can never conflate a user session with an admin one.
export const USER_REFRESH_COOKIE_NAME = "sh_user_refresh";
export const ADMIN_REFRESH_COOKIE_NAME = "sh_admin_refresh";

export const OAUTH_STATE_COOKIE_NAME = "sh_oauth_state";
// Carries which portal started the Google OAuth round-trip, since Google's own "state" param already carries the CSRF token; same lifetime/handling as the state cookie. IMPORTANT: only ever used to pick which frontend origin/cookie pair to use for the callback - NEVER trusted as proof of admin permission, which completeGoogleLogin always re-decides from the verified Google profile + DB user row.
export const OAUTH_PORTAL_COOKIE_NAME = "sh_oauth_portal";

export const ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const ENCRYPTION_IV_BYTES = 12;
