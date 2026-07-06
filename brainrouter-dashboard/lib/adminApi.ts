"use client";

/**
 * ADR-010 P4 — thin authenticated fetch for the admin surfaces (providers +
 * organizations). The endpoints aren't in the SDK yet, so this calls them
 * directly with the stored JWT (refreshing once on a 401) and the optional
 * `X-BrainRouter-Org` active-org header.
 */
import { BASE_URL, refreshAccessToken } from "./client";
import { getApiKey, getJwt } from "./client-auth";

interface FetchOpts {
  method?: string;
  body?: unknown;
  orgId?: string;
}

async function authFetch<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T> {
  const doFetch = (token: string): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.orgId ? { "X-BrainRouter-Org": opts.orgId } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(getJwt() || getApiKey() || "");
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await doFetch(fresh);
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ProviderKind = "llm" | "embedding" | "reranker" | "judge";

export interface ProviderConfig {
  id: string;
  orgId: string;
  kind: ProviderKind;
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  models: string[];
  wireFormat: string;
  reasoningEffort: string;
  enabled: boolean;
  isDefault: boolean;
  hasKey: boolean;
}

export interface ProviderInput {
  kind: ProviderKind;
  providerId?: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  models?: string[];
  wireFormat?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface OrgSummary {
  orgId: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
  capabilities: string[];
  isDefault: boolean;
}

export interface OrgMember {
  orgId: string;
  userId: string;
  role: string;
  createdAt: string;
}

export const adminApi = {
  listProviders: (orgId?: string) =>
    authFetch<{ providers: ProviderConfig[]; secretStorageReady: boolean }>("/api/admin/providers", { orgId }),
  createProvider: (body: ProviderInput, orgId?: string) =>
    authFetch<{ provider: ProviderConfig }>("/api/admin/providers", { method: "POST", body, orgId }),
  updateProvider: (id: string, body: Partial<ProviderInput>, orgId?: string) =>
    authFetch<{ provider: ProviderConfig }>(`/api/admin/providers/${id}`, { method: "PATCH", body, orgId }),
  deleteProvider: (id: string, orgId?: string) =>
    authFetch(`/api/admin/providers/${id}`, { method: "DELETE", orgId }),
  setDefaultProvider: (id: string, orgId?: string) =>
    authFetch(`/api/admin/providers/${id}/default`, { method: "POST", orgId }),
  listOrgs: () => authFetch<{ orgs: OrgSummary[] }>("/api/orgs"),
  listMembers: (orgId: string) => authFetch<{ members: OrgMember[] }>(`/api/orgs/${orgId}/members`, { orgId }),
  addMember: (orgId: string, userId: string, role: string) =>
    authFetch(`/api/orgs/${orgId}/members`, { method: "POST", body: { userId, role }, orgId }),
  removeMember: (orgId: string, userId: string) =>
    authFetch(`/api/orgs/${orgId}/members/${encodeURIComponent(userId)}`, { method: "DELETE", orgId }),
  setDefaultOrg: (orgId: string) => authFetch(`/api/orgs/${orgId}/default`, { method: "POST" }),
};
