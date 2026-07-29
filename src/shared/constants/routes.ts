export const API_ROUTES = {
  health: "/api/health",
  auth: "/api/auth",
  users: "/api/users",
  marketData: "/api/market-data",
  marketCollections: "/api/market-collections",
  scanner: "/api/scanner",
  admin: "/api/admin",
  ai: "/api/ai",
} as const;

export const AUTH_ROUTES = {
  googleUrl: "/google/url",
  googleCallback: "/google/callback",
  refresh: "/refresh",
  me: "/me",
  logout: "/logout",
} as const;

export const GOOGLE_CALLBACK_PATH = `${API_ROUTES.auth}${AUTH_ROUTES.googleCallback}`;
