"use client";

import { BrainRouterClient } from "@brainrouter/sdk";
import { getApiKey, getJwt } from "./client-auth";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3747";

export function getClient() {
  return new BrainRouterClient(BASE_URL, getApiKey() || "", getJwt() || "");
}

export { BASE_URL };
