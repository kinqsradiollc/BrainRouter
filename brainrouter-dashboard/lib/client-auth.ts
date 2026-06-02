"use client";

const JWT_KEY = "brainrouter_jwt";
const REFRESH_KEY = "brainrouter_refresh";
const API_KEY = "brainrouter_api_key";

function safeDecodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload;
  } catch {
    return null;
  }
}

function notExpired(token: string | null | undefined): boolean {
  if (!token) return false;
  const payload = safeDecodeJwtPayload(token);
  if (!payload) return false;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  return exp > Math.floor(Date.now() / 1000);
}

// Access token — ALWAYS localStorage so the session is shared across tabs and
// survives a browser restart. The refresh token transparently renews it.
export function getJwt(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(JWT_KEY) ?? sessionStorage.getItem(JWT_KEY);
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
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(REFRESH_KEY, token);
}

export function clearRefreshToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(REFRESH_KEY);
}

export function getApiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(API_KEY) ?? "";
}

export function setApiKey(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(API_KEY, key);
}

export function clearApiKey(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(API_KEY);
}

export function clearAll(): void {
  clearJwt();
  clearRefreshToken();
  clearApiKey();
}

/** Authenticated if the access token is still valid OR a refresh token can mint
 *  a new one (so an expired access token alone doesn't bounce the user to login). */
export function isAuthenticated(): boolean {
  if (notExpired(getJwt())) return true;
  return notExpired(getRefreshToken());
}

export function signOut(): void {
  clearAll();
  if (typeof window !== "undefined") {
    window.location.replace("/auth");
  }
}

// Backward-compat names used by existing components
export const getClientApiKey = getApiKey;
export const setClientApiKey = setApiKey;
