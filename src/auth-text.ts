// Shared authentication types. UI strings live in locales/.
export type AuthConfig = { mode: "local"; configured: boolean } | { mode: "portal" };
export type LoginGrant = { username: string; csrf: string };
export type AuthFailure = Error & { status?: number; code?: string; retryAfter?: number };
