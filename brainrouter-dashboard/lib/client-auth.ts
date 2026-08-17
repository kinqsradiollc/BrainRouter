"use client";

const JWT_KEY = "brainrouter_jwt";
const REFRESH_KEY = "brainrouter_refresh";
const API_KEY = "brainrouter_api_key";

// Access token — ALWAYS localStorage so the session is shared across tabs and
// survives a browser restart. The refresh token transparently renews it.
export function getJwt(): string | null {
  // ADR-037 D1 — the access token lives in memory (lib/client), never storage.
  return null;
}

export function setJwt(token: string, _rememberMe = true): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(JWT_KEY); // migrate any legacy per-tab token
  localStorage.setItem(JWT_KEY, token);
}

export function clearJwt(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(JWT_KEY);
  localStorage.removeItem(JWT_KEY);
}

export function getRefreshToken(): string | null {
  // ADR-037 D1 — the refresh token is an httpOnly br_refresh cookie the page
  // cannot read. Nothing to return.
  return null;
}

export function setRefreshToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(REFRESH_KEY, token);
}

export function clearRefreshToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(REFRESH_KEY);
}

// ADR-037 D4 — the API key is the worst credential (it never expires). It lives
// in MEMORY only: shown once at login/rotate for the user to copy, never
// persisted to storage where a script could read it after the fact.
let apiKeyInMemory = "";
export function getApiKey(): string {
  return apiKeyInMemory;
}

export function setApiKey(key: string): void {
  apiKeyInMemory = key;
}

export function clearApiKey(): void {
  apiKeyInMemory = "";
}

export function clearAll(): void {
  clearJwt();
  clearRefreshToken();
  clearApiKey();
}

// ADR-037 D-2 — authentication is a cookie session, resolved asynchronously by
// AuthProvider (httpOnly cookie → /refresh → /me). It maintains this flag so the
// remaining synchronous callers (page effects) can read the current state
// without decoding a browser token.
let authedFlag = false;
export function setAuthedFlag(value: boolean): void { authedFlag = value; }
/** The current session state, as last resolved by AuthProvider. */
export function isAuthenticated(): boolean { return authedFlag; }

export function signOut(): void {
  clearAll();
  if (typeof window !== "undefined") {
    window.location.replace("/auth");
  }
}

// Backward-compat names used by existing components
export const getClientApiKey = getApiKey;
export const setClientApiKey = setApiKey;
