"use client";

/**
 * ADR-010 P4 — thin authenticated fetch for the admin surfaces (providers +
 * organizations). The endpoints aren't in the SDK yet, so this calls them
 * directly with the stored JWT (refreshing once on a 401) and the optional
 * `X-BrainRouter-Org` active-org header.
 */
import { BASE_URL, refreshAccessToken } from "./client";
import { getApiKey, getJwt } from "./client-auth";
import type {
  ModelCapabilityProvenanceSource,
  ModelCatalogEnvelope,
  ModelCapabilities,
  ModelReasoningEffort,
  ModelReasoningMode,
  RepositoryReviewAvailability,
} from "@kinqs/brainrouter-types";

interface FetchOpts {
  method?: string;
  body?: unknown;
  orgId?: string;
  signal?: AbortSignal;
}

const DASHBOARD_REQUEST_TIMEOUT_MS = 10_000;

/** Shared authenticated request path for dashboard-only API surfaces that have
 * not landed in the public SDK yet. Keeping refresh/retry and org pinning here
 * prevents feature pages from growing subtly different auth behavior. */
export async function authFetch<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T> {
  const doFetch = (token: string): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      // Never leave a dashboard panel (or the global auth bootstrap) spinning
      // on the browser's multi-minute socket timeout. Callers that own a
      // shorter cancellation policy can still provide their own signal.
      signal: opts.signal ?? AbortSignal.timeout(DASHBOARD_REQUEST_TIMEOUT_MS),
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
    const error = new Error(msg) as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ProviderKind = "llm" | "embedding" | "reranker";

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

export type ManagedModelCapabilitySource = Exclude<ModelCapabilityProvenanceSource, "inferred">;
export type ManagedModelEffortWireMap = Partial<
  Record<ModelReasoningEffort, Record<string, string>>
>;
export interface ManagedModelCapabilities extends ModelCapabilities {
  reasoningMode?: ModelReasoningMode;
  manualBudgetTokens?: "supported" | "unsupported";
}
export interface ManagedModelRecord {
  id: string;
  orgId: string;
  providerConfigId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  allowedEfforts: ModelReasoningEffort[];
  defaultEffort: ModelReasoningEffort | null;
  effortWireMap: ManagedModelEffortWireMap;
  capabilities: ManagedModelCapabilities;
  capabilitySource: ManagedModelCapabilitySource;
  sourceUrl?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export type ManagedModelInput = Omit<ManagedModelRecord, "id" | "orgId" | "createdAt" | "updatedAt">;

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
  /** The user's own solo/local-first org — surfaced as "Personal workspace". */
  isPersonal?: boolean;
}

export interface OrgMember {
  orgId: string;
  userId: string;
  role: string;
  createdAt: string;
}

export interface ReviewJob {
  id: string;
  lens: "security" | "code" | "pentest";
  status: string;
  repo: string | null;
  prNumber: number | null;
  findings: number | null;
  blocking: number | null;
  findingsDetail?: { file: string; line?: number; severity: string; title?: string; summary?: string; status?: string; cwe?: string; preExisting?: boolean; suggestable?: boolean }[];
  progress?: { ts: string; kind: string; msg: string; data?: Record<string, unknown>; traceId?: string; spanId?: string; parentSpanId?: string; role?: string; status?: "pending" | "running" | "succeeded" | "failed" | "skipped"; durationMs?: number }[];
  skipped: string | null;
  error: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface ReviewPullRequest {
  repo: string; number: number; title: string; author: string | null; headSha: string | null; updatedAt: string | null; createdAt: string | null; url: string | null;
  state: string; draft: boolean; comments: number; labels: string[];
  availability: RepositoryReviewAvailability;
  security: ReviewJob | null; code: ReviewJob | null;
}
export interface ReviewPullRequestDetail {
  repo: string; number: number; title: string; author: string | null; branch: string | null; headSha: string | null; url: string | null;
  availability: RepositoryReviewAvailability;
  checks: { id?: number; name?: string; conclusion?: string | null; status?: string; html_url?: string }[];
  reviews: ReviewJob[];
}

export interface ReviewIssue {
  reviewId: string;
  lens: ReviewJob["lens"];
  reviewStatus: string;
  repo: string | null;
  prNumber: number | null;
  issueStatus: string;
  finding: NonNullable<ReviewJob["findingsDetail"]>[number];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewIssuesResponse {
  issues: ReviewIssue[];
  total: number;
  severity: { critical: number; high: number; medium: number; low: number; info: number };
  nextCursor: string | null;
}

export interface ReviewSummary {
  periodDays: number;
  metrics: { securityScore: number; openIssues: number; issuesFound: number; issuesFixed?: number; fixRate: number; prsReviewed: number; pentests: number };
  severity: { critical: number; high: number; medium: number; low: number; info: number };
  verdicts: { approved: number; commented: number; changesRequested: number };
  /** Zero-filled per-day rows for the full period: discoveries by severity plus
   * how many of that day's findings are currently open vs fixed. */
  history: Array<{ date: string; critical: number; high: number; medium: number; low: number; open?: number; fixed?: number }>;
  repositories: Array<{ repository: string; prs: number; findings: number; addressed: number }>;
}

export interface ConnectorStatus {
  source: string;
  connected: boolean;
  connector: { id: string; name: string; status: string; enabled: boolean; hasCredential: boolean; config: Record<string, unknown>; lastRunAt: string | null; lastError: string | null } | null;
  account: string | null;
  scopes: string | null;
  /** GitHub only: how to connect — `device` (bundled App, no secret) vs `web` (configured OAuth App). */
  authMode?: "web" | "device";
  /** GitHub only: whether any connect app (bundled or configured) is available. */
  appConfigured?: boolean;
}

/** One connected (or pending) account for a source — the multi-account unit. */
export interface ConnectorAccount {
  id: string;
  label: string;
  connected: boolean;
  status: string;
  account: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  authMode?: "web" | "device";
}

export interface PentestTarget {
  id: string; orgId: string; createdBy: string; kind: "domain" | "repository"; value: string; normalizedValue: string; label: string | null; authorizedAt: string; createdAt: string; updatedAt: string;
}
export type PentestScanMode = "code-review" | "standard" | "full-audit";
export const PENTEST_SCAN_MODE_LABELS: Record<PentestScanMode, string> = { "code-review": "Code Review", standard: "Standard Pentest", "full-audit": "Full Audit Pentest" };
export interface PentestRun {
  id: string; status: string; targetId: string; target: string; kind: string; scanMode?: PentestScanMode; findings: number; error: string | null; createdAt: string; updatedAt: string;
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
  modelCatalog: (orgId?: string) =>
    authFetch<ModelCatalogEnvelope>("/api/models/catalog", { orgId }),
  listManagedModels: (orgId?: string) =>
    authFetch<{ models: ManagedModelRecord[] }>("/api/admin/models", { orgId }),
  discoverManagedModels: (providerConfigId: string, orgId?: string) =>
    authFetch<{ models: string[]; selection: { mode: "explicit"; upstreamModelIds: string[] } }>(
      "/api/admin/models/discover",
      { method: "POST", body: { providerConfigId }, orgId },
    ),
  createManagedModel: (body: ManagedModelInput, orgId?: string) =>
    authFetch<{ model: ManagedModelRecord }>("/api/admin/models", { method: "POST", body, orgId }),
  updateManagedModel: (id: string, body: Partial<ManagedModelInput>, orgId?: string) =>
    authFetch<{ model: ManagedModelRecord }>(`/api/admin/models/${encodeURIComponent(id)}`, { method: "PATCH", body, orgId }),
  deleteManagedModel: (id: string, orgId?: string) =>
    authFetch<{ ok: true }>(`/api/admin/models/${encodeURIComponent(id)}`, { method: "DELETE", orgId }),
  setDefaultManagedModel: (id: string, orgId?: string) =>
    authFetch<{ ok: true }>(`/api/admin/models/${encodeURIComponent(id)}/default`, { method: "POST", orgId }),
  /** Discover the models an endpoint exposes (GET /models / LM Studio), reusing core. */
  probeModels: (baseUrl: string, apiKey: string, kind = "llm", orgId?: string) =>
    authFetch<{ ok: boolean; models?: { id: string; reasoning?: boolean }[]; error?: string }>(
      "/api/admin/providers/probe-models",
      { method: "POST", body: { baseUrl, apiKey, kind }, orgId },
    ),
  /** Test-embed a model to get its dimension + the store's current one (swap guard). */
  probeEmbeddingDim: (baseUrl: string, apiKey: string, model: string, orgId?: string) =>
    authFetch<{ ok: boolean; dimensions: number | null; currentDimensions: number }>(
      "/api/admin/providers/probe-embedding-dim",
      { method: "POST", body: { baseUrl, apiKey, model }, orgId },
    ),
  /** The providers the shared core (desktop/CLI) supports for a KIND — reused verbatim. */
  providerCatalog: (kind?: string) =>
    authFetch<{ providers: { id: string; label: string; endpoint: string; local: boolean; requestFormat?: string; capabilities?: string[]; defaultModels?: string[] }[] }>(`/api/admin/providers/catalog${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),
  /** Per-subagent-role model routing (desktop/CLI parity). */
  getAgentModels: (orgId?: string) =>
    authFetch<{ roles: string[]; assignments: Record<string, { provider?: string; model?: string; maxDiffChars?: number; timeoutMs?: number }> }>("/api/admin/agent-models", { orgId }),
  setAgentModels: (assignments: Record<string, { provider?: string; model?: string; maxDiffChars?: number; timeoutMs?: number }>, orgId?: string) =>
    authFetch<{ assignments: Record<string, { provider?: string; model?: string; maxDiffChars?: number; timeoutMs?: number }> }>("/api/admin/agent-models", { method: "PUT", body: { assignments }, orgId }),
  // GitHub App / integration configs (RBAC: triggers:manage).
  listIntegrations: (orgId?: string) =>
    authFetch<{ integrations: IntegrationConfig[]; secretStorageReady: boolean }>("/api/admin/integrations", { orgId }),
  createIntegration: (body: IntegrationInput, orgId?: string) =>
    authFetch<{ integration: IntegrationConfig }>("/api/admin/integrations", { method: "POST", body, orgId }),
  updateIntegration: (id: string, body: Partial<IntegrationInput>, orgId?: string) =>
    authFetch<{ integration: IntegrationConfig }>(`/api/admin/integrations/${id}`, { method: "PATCH", body, orgId }),
  deleteIntegration: (id: string, orgId?: string) =>
    authFetch(`/api/admin/integrations/${id}`, { method: "DELETE", orgId }),
  // ADR-017 D5 — recent PR reviews (both lenses) for the Reviews dashboard.
  listReviewJobs: (orgId?: string, limit = 30) =>
    authFetch<{ reviews: ReviewJob[]; canRun: boolean }>(`/api/admin/reviews/jobs?limit=${limit}`, { orgId }),
  reviewSummary: (orgId?: string, days = 30) =>
    authFetch<ReviewSummary>(`/api/admin/reviews/summary?days=${days}`, { orgId }),
  listReviewPrs: (orgId?: string, refresh = false) => authFetch<{
    prs: ReviewPullRequest[]; canRun: boolean; cache?: { fresh: boolean; refreshing: boolean }; partial?: boolean; failedRepositories?: string[];
  }>(`/api/admin/reviews/prs${refresh ? "?refresh=1" : ""}`, { orgId }),
  getReviewPr: (repo: string, number: number, orgId?: string) => {
    const [owner, name] = repo.split("/");
    return authFetch<{ pr: ReviewPullRequestDetail; canRun: boolean }>(`/api/admin/reviews/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`, { orgId });
  },
  getReviewJob: (id: string, orgId?: string) => authFetch<{ review: ReviewJob; canRun: boolean }>(`/api/admin/reviews/jobs/${encodeURIComponent(id)}`, { orgId }),
  getReviewPrActivity: (repo: string, number: number, orgId?: string) => {
    const [owner, name] = repo.split("/");
    return authFetch<{ reviews: ReviewJob[]; canRun: boolean }>(`/api/admin/reviews/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}/activity`, { orgId });
  },
  listReviewIssues: (filters: { limit?: number; severity?: string; repo?: string; status?: string; q?: string; cursor?: string; sort?: "newest" | "oldest" }, orgId?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (filters.limit) query.set("limit", String(filters.limit));
    if (filters.severity && filters.severity !== "all") query.set("severity", filters.severity);
    if (filters.repo && filters.repo !== "all") query.set("repo", filters.repo);
    if (filters.status && filters.status !== "all") query.set("status", filters.status);
    if (filters.q?.trim()) query.set("q", filters.q.trim());
    if (filters.cursor) query.set("cursor", filters.cursor);
    if (filters.sort && filters.sort !== "newest") query.set("sort", filters.sort);
    return authFetch<ReviewIssuesResponse>(`/api/admin/reviews/issues?${query.toString()}`, { orgId, signal });
  },
  runReview: (body: { repo: string; prNumber: number; lens: "security" | "code" | "pentest" | "both" }, orgId?: string) =>
    authFetch<{ jobs: { id: string; lens: "security" | "code" | "pentest" }[] }>("/api/admin/reviews/run", { method: "POST", body, orgId }),
  // ADR-016 — the deployment's GitHub OAuth App (for per-user "Connect GitHub").
  getGithubOAuthApp: () =>
    authFetch<{ configured: boolean; clientId: string; hasSecret: boolean; redirectBase: string; secretStorageReady: boolean }>("/api/admin/connectors/github/app"),
  setGithubOAuthApp: (body: { clientId: string; clientSecret?: string; redirectBase?: string }) =>
    authFetch<{ ok: boolean; configured: boolean; hasSecret: boolean }>("/api/admin/connectors/github/app", { method: "POST", body }),
  // ADR-016 — per-source connector OAuth apps (GitLab / Slack / Drive / Gmail / Notion /
  // Linear), configured in Integrations just like the GitHub OAuth App. No secrets returned.
  getConnectorOAuthApps: (orgId?: string) =>
    authFetch<{ apps: Array<{ source: string; configured: boolean; hasSecret: boolean; clientId: string; scopes: string; defaultScopes: string; usesPkce: boolean }> }>("/api/connectors/oauth/apps", { orgId }),
  setConnectorOAuthApp: (source: string, body: { clientId: string; clientSecret?: string; scopes?: string }, orgId?: string) =>
    authFetch<{ app: unknown }>(`/api/connectors/${source}/oauth/app`, { method: "POST", body, orgId }),
  startConnectorOAuth: (source: string, connectorId?: string, orgId?: string) =>
    authFetch<{ url: string }>(`/api/connectors/${encodeURIComponent(source)}/oauth/start${connectorId ? `?connectorId=${encodeURIComponent(connectorId)}` : ""}`, { method: "POST", orgId }),
  startGithubDevice: (orgId?: string, connectorId?: string) =>
    authFetch<{ userCode: string; verificationUri: string; interval: number; expiresIn: number }>("/api/connectors/github/device/start", { method: "POST", orgId, ...(connectorId ? { body: { connectorId } } : {}) }),
  /** All accounts (connectors) the caller has for a source — multi-account. */
  connectorAccounts: (source: string, orgId?: string) =>
    authFetch<{ source: string; accounts: ConnectorAccount[] }>(`/api/connectors/${encodeURIComponent(source)}/accounts`, { orgId }),
  /** Start a NEW account for a source (empty connector the flow then binds to). */
  addConnectorAccount: (source: string, label: string, orgId?: string) =>
    authFetch<{ connector: { id: string; name: string } }>(`/api/connectors/${encodeURIComponent(source)}/accounts`, { method: "POST", body: { label }, orgId }),
  /** Remove one account (connector) by id. */
  deleteConnectorAccount: (id: string, orgId?: string) =>
    authFetch<{ ok?: boolean }>(`/api/connectors/${encodeURIComponent(id)}`, { method: "DELETE", orgId }),
  pollGithubDevice: (orgId?: string) =>
    authFetch<{ status: "pending" | "connected" | "expired" | "error"; login?: string; error?: string }>("/api/connectors/github/device/poll", { method: "POST", orgId }),
  cancelGithubDevice: (orgId?: string) =>
    authFetch<{ ok: boolean }>("/api/connectors/github/device/cancel", { method: "POST", orgId }),
  connectorStatus: (source: string, orgId?: string) =>
    authFetch<ConnectorStatus>(`/api/connectors/${encodeURIComponent(source)}/status`, { orgId }),
  /** Resources for ONE account. Pass connectorId to scope to a specific account
   * (multi-account); omit it and the backend falls back to the first account. */
  connectorResources: (source: string, connectorId?: string, orgId?: string) =>
    authFetch<{ source: string; connected: boolean; resources: { id: string; label: string; selected: boolean; kind?: string }[] }>(`/api/connectors/${encodeURIComponent(source)}/resources${connectorId ? `?connectorId=${encodeURIComponent(connectorId)}` : ""}`, { orgId }),
  setConnectorResources: (source: string, connectorId: string, resourceIds: string[], orgId?: string) =>
    authFetch<{ connector: ConnectorStatus["connector"] }>(`/api/connectors/${encodeURIComponent(source)}/resources`, { method: "PUT", body: { resourceIds, connectorId }, orgId }),
  setConnectorSchedule: (id: string, enabled: boolean, orgId?: string) =>
    authFetch<{ connector: ConnectorStatus["connector"] }>(`/api/connectors/${encodeURIComponent(id)}`, { method: "PATCH", body: { enabled }, orgId }),
  runConnector: (id: string, orgId?: string) =>
    authFetch<{ result: { ok: boolean; documents: number; imported: number; error?: string } }>(`/api/connectors/${encodeURIComponent(id)}/run`, { method: "POST", orgId }),
  disconnectConnector: (source: string, orgId?: string) =>
    authFetch<{ ok: boolean; connector: ConnectorStatus["connector"] }>(`/api/connectors/${encodeURIComponent(source)}/disconnect`, { method: "POST", orgId }),
  listPentestTargets: (orgId?: string) => authFetch<{ targets: PentestTarget[] }>("/api/admin/pentests/targets", { orgId }),
  createPentestTarget: (body: { kind: "domain" | "repository"; value: string; label?: string; authorized: true }, orgId?: string) => authFetch<{ target: PentestTarget }>("/api/admin/pentests/targets", { method: "POST", body, orgId }),
  deletePentestTarget: (id: string, orgId?: string) => authFetch<{ ok: boolean }>(`/api/admin/pentests/targets/${encodeURIComponent(id)}`, { method: "DELETE", orgId }),
  listPentestRuns: (orgId?: string, limit = 100) => authFetch<{ runs: PentestRun[] }>(`/api/admin/pentests/runs?limit=${limit}`, { orgId }),
  startPentestRun: (targetId: string, scanMode: PentestScanMode = "standard", orgId?: string) => authFetch<{ run: PentestRun }>("/api/admin/pentests/runs", { method: "POST", body: { targetId, scanMode }, orgId }),
  listOrgs: (signal?: AbortSignal) => authFetch<{ orgs: OrgSummary[] }>("/api/orgs", { signal }),
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
  // Team spaces — active-organization teams plus the caller's global personal teams.
  listTeams: (orgId?: string) => authFetch<{ teams: Team[] }>("/api/teams", { orgId }),
  createTeam: (name: string, kind: TeamKind = "organization", orgId?: string) =>
    authFetch<{ team: Team }>("/api/teams", { method: "POST", body: { name, kind }, orgId }),
  getTeam: (id: string, orgId?: string) =>
    authFetch<{ team: Team; members: TeamMember[]; currentUserId: string }>(`/api/teams/${encodeURIComponent(id)}`, { orgId }),
  addTeamMember: (id: string, account: string, role?: string, orgId?: string) =>
    authFetch<{ ok: boolean; members: TeamMember[] }>(`/api/teams/${encodeURIComponent(id)}/members`, {
      method: "POST", body: { ...(account.includes("@") ? { email: account } : { userId: account }), ...(role ? { role } : {}) }, orgId,
    }),
  removeTeamMember: (id: string, userId: string, orgId?: string) =>
    authFetch(`/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE", orgId }),
  deleteTeam: (id: string, orgId?: string) =>
    authFetch(`/api/teams/${encodeURIComponent(id)}`, { method: "DELETE", orgId }),
  // GitHub App repo linking (RBAC: triggers:manage).
  githubStatus: (orgId: string) =>
    authFetch<{ configured: boolean; installed: boolean; installUrl?: string }>(`/api/orgs/${orgId}/github/status`, { orgId }),
  githubRepos: (orgId: string) =>
    authFetch<{ configured: boolean; installed: boolean; repos: { fullName: string; url: string; private: boolean; defaultBranch: string }[]; error?: string }>(`/api/orgs/${orgId}/github/repos`, { orgId }),
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
  listProjects: (orgId: string, signal?: AbortSignal) =>
    authFetch<{ projects: Project[] }>(`/api/orgs/${orgId}/projects`, { orgId, signal }),
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

export interface Team {
  id: string;
  kind: TeamKind;
  orgId: string | null;
  orgName: string | null;
  ownerUserId: string | null;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
  myRole: "owner" | "admin" | "member" | null;
  canManage: boolean;
}

export type TeamKind = "organization" | "personal";

export interface TeamMember {
  userId: string;
  role: string;
  displayName?: string;
  email?: string;
  createdAt?: string;
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
