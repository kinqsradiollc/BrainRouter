"use client";

import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import { getApiKey, clearAll } from "./client-auth";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3747";

// ADR-037 D1/D-2 — the access token lives in a module variable, never in
// storage: an XSS can use the session while it runs but cannot take a credential
// away with it. The refresh token rides an httpOnly `br_refresh` cookie the page
// cannot read; a fresh access token is minted from it on load and on 401.
let accessToken: string | null = null;
export function getAccessToken(): string | null { return accessToken; }
export function setAccessToken(token: string | null): void { accessToken = token; }

/** Read the readable `br_csrf` double-submit cookie the server sets on
 *  login/refresh. Read from the cookie (not held in memory) precisely so it
 *  survives a page reload — an in-memory token could not bootstrap /refresh
 *  after a reload, and the cookie-path /refresh requires it. */
export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i >= 0 && part.slice(0, i).trim() === "br_csrf") {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

// Single in-flight refresh so a burst of 401s triggers one /refresh, not many.
let refreshInFlight: Promise<string | null> | null = null;

/** Mint a fresh access token from the httpOnly refresh cookie. Returns the new
 *  access token, or null (and clears the session) when refresh is impossible. */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const csrf = getCsrfToken();
        const response = await fetch(`${BASE_URL}/api/auth/refresh`, {
          method: "POST",
          credentials: "include", // send the br_refresh + br_csrf cookies
          headers: {
            "Content-Type": "application/json",
            ...(csrf ? { "X-BrainRouter-Csrf": csrf } : {}),
          },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            accessToken = null;
            clearAll();
          }
          return null;
        }
        const refreshed = await response.json() as { jwt?: string };
        if (!refreshed.jwt) throw new Error("Refresh returned no access token");
        accessToken = refreshed.jwt;
        return accessToken;
      } catch {
        // Offline/timeout is not evidence the cookie is bad; keep the in-memory
        // session so a later request can recover.
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function getClient() {
  return new BrainRouterClient(BASE_URL, getApiKey() || "", accessToken || "", refreshAccessToken);
}

export { BASE_URL };
