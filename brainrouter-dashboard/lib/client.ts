"use client";

import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import { getApiKey, getJwt, getRefreshToken, setJwt, setRefreshToken, clearAll } from "./client-auth";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3747";

// Single in-flight refresh so a burst of 401s triggers one /refresh, not many.
let refreshInFlight: Promise<string | null> | null = null;

/** Mint a fresh access token from the stored refresh token. Returns the new
 *  access token, or null (and clears the session) if refresh is impossible. */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${BASE_URL}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          if (response.status === 400 || response.status === 401 || response.status === 403) clearAll();
          return null;
        }
        const refreshed = await response.json() as { jwt?: string; refreshToken?: string };
        if (!refreshed.jwt) throw new Error("Refresh returned no access token");
        setJwt(refreshed.jwt);
        if (refreshed.refreshToken) setRefreshToken(refreshed.refreshToken);
        return refreshed.jwt;
      } catch {
        // Offline/timeout is not evidence that the refresh credential is bad.
        // Keep it so a later request can recover without forcing a sign-in.
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function getClient() {
  return new BrainRouterClient(BASE_URL, getApiKey() || "", getJwt() || "", refreshAccessToken);
}

export { BASE_URL };
