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
  reasoningEffort?: string;
  extra?: Record<string, unknown>;
  enabled?: boolean;
  isDefault?: boolean;
}

export type IntegrationKind = "github_app";

export interface IntegrationConfig {
  id: string;
  orgId: string;
  kind: IntegrationKind;
  enabled: boolean;
  config: Record<string, unknown>;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationInput {
  kind: IntegrationKind;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** github_app: { privateKey, webhookSecret }. Omit to keep the stored secret. */
  secret?: Record<string, string>;
}

export type OrgPlan = "free" | "pro" | "team" | "enterprise" | "self_hosted_enterprise";

/** The plan tiers (mirrors the backend `ORG_PLANS`), with UI copy. */
export const ORG_PLANS: { value: OrgPlan; label: string; description: string }[] = [
  { value: "free", label: "Free", description: "Solo, local-first — just you." },
  { value: "pro", label: "Pro", description: "Solo, supercharged — more projects, hosted MCP, advanced connectors." },
  { value: "team", label: "Team", description: "A shared team with roles, org memory, and invitations." },
  { value: "enterprise", label: "Enterprise", description: "Org-wide tenancy, SSO, domain allowlist, and audit logs." },
  { value: "self_hosted_enterprise", label: "Enterprise (Self-hosted)", description: "Enterprise features, run on your own infrastructure." },
];

export interface OrgEntitlements {
  limits: { seats: number | null; projects: number | null };
  features: string[];
}

export interface OrgSummary {
  orgId: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
  capabilities: string[];
  entitlements?: OrgEntitlements;
  allowedDomains?: string[];
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
  /** Discover the models an endpoint exposes (GET /models / LM Studio), reusing core. */
  probeModels: (baseUrl: string, apiKey: string, orgId?: string) =>
    authFetch<{ ok: boolean; models?: { id: string; reasoning?: boolean }[]; error?: string }>(
      "/api/admin/providers/probe-models",
      { method: "POST", body: { baseUrl, apiKey }, orgId },
    ),
  /** The providers the shared core (desktop/CLI) supports for a KIND — reused verbatim. */
  providerCatalog: (kind?: string) =>
    authFetch<{ providers: { id: string; label: string; endpoint: string; local: boolean; requestFormat?: string; capabilities?: string[]; defaultModels?: string[] }[] }>(`/api/admin/providers/catalog${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),
  /** Per-subagent-role model routing (desktop/CLI parity). */
  getAgentModels: (orgId?: string) =>
    authFetch<{ roles: string[]; assignments: Record<string, { provider?: string; model?: string }> }>("/api/admin/agent-models", { orgId }),
  setAgentModels: (assignments: Record<string, { provider?: string; model?: string }>, orgId?: string) =>
    authFetch<{ assignments: Record<string, { provider?: string; model?: string }> }>("/api/admin/agent-models", { method: "PUT", body: { assignments }, orgId }),
  // GitHub App / integration configs (RBAC: triggers:manage).
  listIntegrations: (orgId?: string) =>
    authFetch<{ integrations: IntegrationConfig[]; secretStorageReady: boolean }>("/api/admin/integrations", { orgId }),
  createIntegration: (body: IntegrationInput, orgId?: string) =>
    authFetch<{ integration: IntegrationConfig }>("/api/admin/integrations", { method: "POST", body, orgId }),
  updateIntegration: (id: string, body: Partial<IntegrationInput>, orgId?: string) =>
    authFetch<{ integration: IntegrationConfig }>(`/api/admin/integrations/${id}`, { method: "PATCH", body, orgId }),
  deleteIntegration: (id: string, orgId?: string) =>
    authFetch(`/api/admin/integrations/${id}`, { method: "DELETE", orgId }),
  listOrgs: () => authFetch<{ orgs: OrgSummary[] }>("/api/orgs"),
  createOrg: (name: string, plan: OrgPlan = "team") =>
    authFetch<{ org: OrgSummary }>("/api/orgs", { method: "POST", body: { name, plan } }),
  updateOrgPlan: (orgId: string, plan: OrgPlan) =>
    authFetch<{ org: OrgSummary }>(`/api/orgs/${orgId}/plan`, { method: "POST", body: { plan }, orgId }),
  updateAllowedDomains: (orgId: string, domains: string[]) =>
    authFetch<{ org: { orgId: string; allowedDomains: string[] } }>(`/api/orgs/${orgId}/allowed-domains`, { method: "POST", body: { domains }, orgId }),
  listMembers: (orgId: string) => authFetch<{ members: OrgMember[] }>(`/api/orgs/${orgId}/members`, { orgId }),
  addMember: (orgId: string, userId: string, role: string) =>
    authFetch(`/api/orgs/${orgId}/members`, { method: "POST", body: { userId, role }, orgId }),
  inviteMemberByEmail: (orgId: string, email: string, role: string) =>
    authFetch(`/api/orgs/${orgId}/members`, { method: "POST", body: { email, role }, orgId }),
  removeMember: (orgId: string, userId: string) =>
    authFetch(`/api/orgs/${orgId}/members/${encodeURIComponent(userId)}`, { method: "DELETE", orgId }),
  setDefaultOrg: (orgId: string) => authFetch(`/api/orgs/${orgId}/default`, { method: "POST" }),
  // Invitations (ADR-014 Phase B2).
  invite: (orgId: string, email: string, role: string) =>
    authFetch<{ invite: { email: string; role: string; expiresAt: string }; delivered: boolean; link?: string }>(`/api/orgs/${orgId}/invites`, { method: "POST", body: { email, role }, orgId }),
  listInvites: (orgId: string) =>
    authFetch<{ invites: OrgInvite[] }>(`/api/orgs/${orgId}/invites`, { orgId }),
  revokeInvite: (orgId: string, tokenHash: string) =>
    authFetch(`/api/orgs/${orgId}/invites/${tokenHash}`, { method: "DELETE", orgId }),
  acceptInvite: (token: string) =>
    authFetch<{ ok: boolean; orgId: string; name?: string }>(`/api/orgs/accept-invite`, { method: "POST", body: { token } }),
  // Admin SMTP settings (system-global).
  getEmailSettings: () => authFetch<{ config: EmailSettings | null; configured: boolean }>("/api/admin/email"),
  putEmailSettings: (body: EmailSettingsInput) =>
    authFetch<{ config: EmailSettings; configured: boolean }>("/api/admin/email", { method: "PUT", body }),
  testEmail: (to?: string) =>
    authFetch<{ delivered: boolean; transport: string; detail?: string }>("/api/admin/email/test", { method: "POST", body: { to } }),
  // Artifact sharing (ADR-014 Phase D).
  listOrgShared: (orgId: string, limit = 50) =>
    authFetch<{ shared: SharedMemory[] }>(`/api/memories/org/${orgId}/shared?limit=${limit}`, { orgId }),
  shareMemory: (recordId: string, orgId: string) =>
    authFetch(`/api/memories/${encodeURIComponent(recordId)}/share`, { method: "POST", body: { orgId }, orgId }),
  unshareMemory: (recordId: string, orgId: string) =>
    authFetch(`/api/memories/${encodeURIComponent(recordId)}/unshare`, { method: "POST", body: { orgId }, orgId }),
  // Projects (ADR-014 Phase E).
  listProjects: (orgId: string) =>
    authFetch<{ projects: Project[] }>(`/api/orgs/${orgId}/projects`, { orgId }),
  createProject: (orgId: string, body: { name: string; repoUrl?: string; restricted?: boolean }) =>
    authFetch<{ project: Project }>(`/api/orgs/${orgId}/projects`, { method: "POST", body, orgId }),
  updateProject: (orgId: string, projectId: string, patch: { name?: string; repoUrl?: string | null; restricted?: boolean }) =>
    authFetch<{ project: Project }>(`/api/orgs/${orgId}/projects/${projectId}`, { method: "PATCH", body: patch, orgId }),
  deleteProject: (orgId: string, projectId: string) =>
    authFetch(`/api/orgs/${orgId}/projects/${projectId}`, { method: "DELETE", orgId }),
  // Admin console (ADR-014 Phase F) — system-admin oversight of every team.
  listAllOrgs: () => authFetch<{ orgs: OrgStats[]; total: number }>("/api/admin/orgs"),
  listOrgAudit: (orgId: string) => authFetch<{ audit: OrgAuditEntry[] }>(`/api/orgs/${orgId}/audit`, { orgId }),
};

export interface OrgStats {
  orgId: string;
  name: string;
  slug: string;
  plan: string;
  memberCount: number;
  projectCount: number;
  ownerId: string | null;
  createdAt: string;
  seatLimit: number | null;
  projectLimit: number | null;
  overSeats: boolean;
}

export interface OrgAuditEntry {
  id: number;
  actorId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  createdAt: string;
}

export interface Project {
  projectId: string;
  orgId: string;
  name: string;
  slug: string;
  repoUrl: string | null;
  restricted: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface SharedMemory {
  recordId: string;
  userId: string;
  content: string;
  type: string;
  priority: number;
  skillTag: string;
  visibility: string;
  createdTime: string;
}

export interface OrgInvite {
  email: string;
  role: string;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
  tokenHash: string;
}

export interface EmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  from: string;
  appUrl?: string;
  hasPassword?: boolean;
}
export type EmailSettingsInput = Omit<EmailSettings, "hasPassword"> & { pass?: string };
