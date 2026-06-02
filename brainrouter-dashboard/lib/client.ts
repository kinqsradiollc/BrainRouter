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
        const res = await new BrainRouterClient(BASE_URL).refresh(refreshToken);
        setJwt(res.jwt);
        if (res.refreshToken) setRefreshToken(res.refreshToken);
        return res.jwt;
      } catch {
        clearAll();
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
