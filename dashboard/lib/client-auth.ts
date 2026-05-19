"use client";

const JWT_KEY = "brainrouter_jwt";
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

export function getJwt(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(JWT_KEY);
}

export function setJwt(token: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(JWT_KEY, token);
}

export function clearJwt(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(JWT_KEY);
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

export function isAuthenticated(): boolean {
  const jwt = getJwt();
  if (!jwt) return false;
  const payload = safeDecodeJwtPayload(jwt);
  if (!payload) return false;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  return exp > Math.floor(Date.now() / 1000);
}

export function signOut(): void {
  clearJwt();
  clearApiKey();
  if (typeof window !== "undefined") {
    window.location.replace("/auth");
  }
}

// Backward-compat names used by existing components
export const getClientApiKey = getApiKey;
export const setClientApiKey = setApiKey;
