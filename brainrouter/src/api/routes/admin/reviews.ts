/** PR review console API: org-scoped jobs, manual runs, GitHub PR metadata and timelines. */
import { Router } from "express";
import { mintInstallationToken, validateGithubApiBase } from "@kinqs/brainrouter-core/track";
import type { MemoryJobRecord, RepositoryReviewAvailability, ReviewJobDto } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { attachOrgContext, requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { can } from "../../../tenancy/rbac.js";
import { canAccessGithubRepository, isRepoAvailableForManualReview, isRepoLinkedForReview } from "../../../integrations/githubWebhook.js";
import { resolveGithubAccountToken } from "../../../connectors/githubAccountToken.js";
import { createReviewPullRequestLoader } from "./reviewDataLoader.js";

export const reviewsRouter = Router();
reviewsRouter.use(requireAnyAuth);

type Store = Partial<{
  listReviewJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]>;
  listReviewJobSummariesForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]>;
  listReviewAnalyticsForOrg(orgId: string, since: string, limit?: number): Promise<MemoryJobRecord[]>;
  listReviewJobsForPr(orgId: string, repo: string, prNumber: number, limit?: number): Promise<MemoryJobRecord[]>;
  listReviewFindingsForOrg(orgId: string, query?: {
    limit?: number; severity?: string; repo?: string; status?: string; search?: string;
    cursor?: { createdAt: string; reviewId: string; ordinal: number };
    sort?: "newest" | "oldest";
  }): Promise<Array<{
    reviewId: string; lens: "security" | "code" | "pentest"; reviewStatus: string; repo: string | null; prNumber: number | null;
    issueStatus: string; ordinal: number; finding: Record<string, unknown>; createdAt: string; updatedAt: string; total: number;
    severityCounts: { critical: number; high: number; medium: number; low: number; info: number };
  }>>;
  getMemoryJob(id: string): Promise<MemoryJobRecord | null>;
  listMemoryJobs(filters?: { kind?: string; status?: string[]; limit?: number }): Promise<MemoryJobRecord[]>;
  enqueueMemoryJob(input: { kind: string; input: Record<string, unknown>; maxAttempts?: number }): Promise<MemoryJobRecord>;
}>;
type Lens = "security" | "code" | "pentest" | "both";

interface GithubPrRow {
  repo: string;
  number: number;
  title: string;
  author: string | null;
  headSha: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  url: string | null;
  state: string;
  draft: boolean;
  comments: number;
  labels: string[];
}

const pullRequestLoader = createReviewPullRequestLoader<GithubPrRow>();

function reviewRecord(job: MemoryJobRecord): ReviewJobDto {
  const input = (job.input ?? {}) as { repo?: string; prNumber?: number; target?: string; forge?: "github" | "gitlab" };
  const output = (job.output ?? {}) as { findings?: number; blocking?: number; posted?: boolean; error?: string; skipped?: string; findingsDetail?: unknown[] };
  return {
    id: job.id, lens: job.kind === "pr-code-review" ? "code" : (job.kind === "pr-pentest" || job.kind === "domain-pentest") ? "pentest" : "security", status: job.status,
    repo: input.repo ?? input.target ?? null, prNumber: input.prNumber ?? null, forge: input.forge === "gitlab" ? "gitlab" : "github",
    findings: typeof output.findings === "number" ? output.findings : null,
    blocking: typeof output.blocking === "number" ? output.blocking : null,
    findingsDetail: Array.isArray(output.findingsDetail) ? output.findingsDetail as ReviewJobDto["findingsDetail"] : [], progress: job.progress ?? [],
    skipped: output.skipped ?? null, error: job.error ?? output.error ?? null, updatedAt: job.updatedAt, createdAt: job.createdAt,
  };
}

async function integration(orgId: string) {
  return memoryEngine.integrations.getResolvedIntegration(orgId, "github_app");
}

type GithubReviewStateContext = {
  accountConnected: boolean;
  automaticReviewConfig?: Record<string, unknown>;
};

async function githubReviewStateContext(orgId: string, userId: string): Promise<GithubReviewStateContext> {
  const [integ, account] = await Promise.all([
    integration(orgId).catch(() => null),
    resolveGithubAccountToken(memoryEngine.emailAuth, userId).catch(() => null),
  ]);
  const appConfigured = Boolean(
    String(integ?.config.appId ?? "").trim()
    && String(integ?.config.installationId ?? "").trim()
    && String(integ?.secret.privateKey ?? "").trim(),
  );
  return {
    accountConnected: Boolean(account),
    automaticReviewConfig: appConfigured ? integ?.config : undefined,
  };
}

function reviewAvailability(
  context: GithubReviewStateContext,
  repo: string,
  repositoryAccessible: boolean,
): RepositoryReviewAvailability {
  return {
    accountConnected: context.accountConnected,
    repositoryAccessible,
    autoReviewEnabled: Boolean(
      context.automaticReviewConfig
      && isRepoLinkedForReview(context.automaticReviewConfig, repo),
    ),
  };
}
function ghHeaders(token: string) { return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }; }
async function githubToken(orgId: string) {
  const integ = await integration(orgId);
  const appId = String(integ?.config.appId ?? "").trim();
  const privateKey = String(integ?.secret.privateKey ?? "").trim();
  const installationId = String(integ?.config.installationId ?? "").trim();
  if (!integ || !appId || !privateKey || !installationId) return null;
  const apiBase = validateGithubApiBase(typeof integ.config.apiBase === "string" ? integ.config.apiBase : "") ?? "https://api.github.com";
  const token = await mintInstallationToken({ appId, privateKey, apiBase }, installationId, { fetchImpl: fetch as never, nowSec: () => Math.floor(Date.now() / 1000) });
  return { integ, apiBase, token: token.token, installationId };
}
type ManualReviewAuthorization = {
  credentialSource: "github_app" | "github_account" | "gitlab_account";
  installationId: string;
};
type GithubReviewAuthorization = ManualReviewAuthorization & {
  credentialSource: "github_app" | "github_account";
  apiBase: string;
  token: string;
  reviewConfig?: Record<string, unknown>;
};

async function githubAppAuthorization(orgId: string): Promise<GithubReviewAuthorization | null> {
  try {
    const app = await githubToken(orgId);
    return app ? {
      credentialSource: "github_app",
      installationId: app.installationId,
      apiBase: app.apiBase,
      token: app.token,
      reviewConfig: app.integ.config,
    } : null;
  } catch {
    return null;
  }
}

async function githubAccountAuthorization(userId: string): Promise<GithubReviewAuthorization | null> {
  const account = await resolveGithubAccountToken(memoryEngine.emailAuth, userId);
  return account ? {
    credentialSource: "github_account",
    installationId: "",
    apiBase: "https://api.github.com",
    token: account.accessToken,
  } : null;
}

/** Resolve a credential that can reach one repository. Automatic-review
 * enrollment is deliberately not an access gate for an explicit console read. */
async function githubReviewAuthorization(orgId: string, userId: string, repo: string): Promise<GithubReviewAuthorization | null> {
  const app = await githubAppAuthorization(orgId);
  if (app && await isRepoAvailableForManualReview(app.reviewConfig, repo, app)) return app;

  const account = await githubAccountAuthorization(userId);
  if (account && await canAccessGithubRepository(repo, account)) return account;
  return null;
}

async function manualReviewAuthorization(orgId: string, userId: string, repo: string, forge: "github" | "gitlab"): Promise<ManualReviewAuthorization | null> {
  if (forge === "gitlab") {
    const account = await memoryEngine.findGitlabAccountAuthorization(userId, orgId);
    if (!account) return null;
    try {
      const response = await fetch(`${account.apiBase}/projects/${encodeURIComponent(repo)}`, {
        headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      return response.ok ? { credentialSource: "gitlab_account", installationId: "" } : null;
    } catch { return null; }
  }
  // Prefer the org's dedicated App bot when one exists. Fall back to the same
  // per-user GitHub authorization that powers Connectors and Track, so a user
  // never has to configure the same repository twice just to run a manual review.
  const authorization = await githubReviewAuthorization(orgId, userId, repo);
  return authorization ? {
    credentialSource: authorization.credentialSource,
    installationId: authorization.installationId,
  } : null;
}

async function listGithubRepositories(
  auth: GithubReviewAuthorization,
): Promise<string[] | null> {
  const path = auth.credentialSource === "github_app"
    ? "/installation/repositories?per_page=100"
    : "/user/repos?per_page=100&sort=updated";
  try {
    const response = await fetch(`${auth.apiBase}${path}`, { headers: ghHeaders(auth.token) });
    if (!response.ok) return null;
    const payload = await response.json() as { repositories?: Array<{ full_name?: unknown }> } | Array<{ full_name?: unknown }>;
    const records = Array.isArray(payload) ? payload : (payload.repositories ?? []);
    return records.map((repo) => String(repo.full_name ?? "")).filter((repo) => validRepo(repo));
  } catch {
    return null;
  }
}

/** List repositories for the review console, independently of the webhook
 * auto-review allowlist. A broken/missing App falls back to the requester's
 * signed-in GitHub account without returning either credential to the client. */
async function githubConsoleRepositories(orgId: string, userId: string): Promise<{
  auth: GithubReviewAuthorization;
  repos: string[];
} | null> {
  const app = await githubAppAuthorization(orgId);
  if (app) {
    const repos = await listGithubRepositories(app);
    if (repos) return { auth: app, repos };
  }
  const account = await githubAccountAuthorization(userId);
  if (!account) return null;
  const repos = await listGithubRepositories(account);
  return repos ? { auth: account, repos } : null;
}
async function canRun(req: AuthedRequest): Promise<boolean> {
  if (req.isAdmin || can(req.role, "reviews:run")) return true;
  if (req.role !== "developer") return false;
  const integ = await integration(req.orgId!);
  return (integ?.config.reviewPolicyDefaults as { developersCanRun?: unknown } | undefined)?.developersCanRun === true;
}
async function requireRun(req: AuthedRequest, res: any): Promise<boolean> {
  if (!(await attachOrgContext(req, res))) return false;
  if (await canRun(req)) return true;
  sendError(res, 403, "This action requires the 'reviews:run' capability");
  return false;
}
function validRepo(repo: unknown, forge: "github" | "gitlab" = "github"): repo is string {
  if (typeof repo !== "string") return false;
  const segments = repo.split("/");
  return segments.length >= 2 && (forge === "gitlab" || segments.length === 2)
    && segments.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
}

function encodeFindingCursor(row: { createdAt: string; reviewId: string; ordinal: number }): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.reviewId, row.ordinal]), "utf8").toString("base64url");
}

function decodeFindingCursor(value: unknown): { createdAt: string; reviewId: string; ordinal: number } | null | "invalid" {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) return "invalid";
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || !Number.isInteger(parsed[2]) || Number(parsed[2]) < 1) return "invalid";
    return { createdAt: parsed[0], reviewId: parsed[1], ordinal: Number(parsed[2]) };
  } catch { return "invalid"; }
}

/** GET /jobs — compact recent list; developer-readable. */
reviewsRouter.get("/jobs", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const jobs = (await (memoryEngine.store as Store).listReviewJobsForOrg?.(req.orgId!, limit)) ?? [];
  res.json({ reviews: jobs.map(reviewRecord), canRun: await canRun(req) });
});

/** GET /issues — compact, server-filtered finding pages with trace provenance. */
reviewsRouter.get("/issues", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const cursor = decodeFindingCursor(req.query.cursor);
  if (cursor === "invalid") { sendError(res, 400, "Invalid issues cursor"); return; }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const severity = typeof req.query.severity === "string" && req.query.severity !== "all" ? req.query.severity : undefined;
  const repo = typeof req.query.repo === "string" && req.query.repo !== "all" ? req.query.repo : undefined;
  const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status : undefined;
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : undefined;
  const sort = req.query.sort === "oldest" ? "oldest" : "newest";
  if (repo && !validRepo(repo)) { sendError(res, 400, "Invalid repository filter"); return; }
  const rows = (await (memoryEngine.store as Store).listReviewFindingsForOrg?.(req.orgId!, {
    limit, severity, repo, status, search: search || undefined, cursor: cursor ?? undefined, sort,
  })) ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  res.json({
    issues: page.map((row) => ({
      reviewId: row.reviewId, lens: row.lens, reviewStatus: row.reviewStatus, repo: row.repo, prNumber: row.prNumber,
      issueStatus: row.issueStatus, finding: row.finding, createdAt: row.createdAt, updatedAt: row.updatedAt,
    })),
    total: rows[0]?.total ?? 0,
    severity: rows[0]?.severityCounts ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    nextCursor: hasMore && last ? encodeFindingCursor(last) : null,
  });
});

/** GET /summary — analytics-friendly rollup for the dashboard.  The raw jobs
 * remain the source of truth; this route keeps the browser from reimplementing
 * time bucketing and severity parsing on every render. */
reviewsRouter.get("/summary", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
  const now = Date.now();
  const since = now - days * 86_400_000;
  const jobs = (await (memoryEngine.store as Store).listReviewAnalyticsForOrg?.(req.orgId!, new Date(since).toISOString(), 1_000)) ?? [];
  const recent = jobs.map(reviewRecord).filter((job) => Date.parse(job.createdAt) >= since);
  // Per-finding status vocabulary mirrors the Issues tabs (open / in progress /
  // snoozed / fixed / ignored; a missing status means open). Only "fixed" is
  // remediated; "ignored" is closed-but-not-fixed, so it counts in neither the
  // open figures nor the fix rate's numerator.
  const statusOf = (finding: { status?: unknown }): string => String(finding.status ?? "open").toLowerCase();
  const severity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }; // OPEN findings only
  const verdicts = { approved: 0, commented: 0, changesRequested: 0 };
  type DayBucket = { critical: number; high: number; medium: number; low: number; open: number; fixed: number };
  const emptyDay = (): DayBucket => ({ critical: 0, high: 0, medium: 0, low: 0, open: 0, fixed: 0 });
  // Zero-fill every day of the window so the time axis is continuous — sparse
  // activity previously collapsed into adjacent points and distorted the chart.
  const byDay = new Map<string, DayBucket>();
  for (let ts = since; ts <= now; ts += 86_400_000) byDay.set(new Date(ts).toISOString().slice(0, 10), emptyDay());
  let issuesFound = 0;
  let issuesFixed = 0;
  for (const job of recent) {
    const day = job.createdAt.slice(0, 10);
    const bucket = byDay.get(day) ?? emptyDay();
    for (const finding of job.findingsDetail ?? []) {
      const key = String(finding.severity ?? "").toLowerCase() as keyof typeof severity;
      const status = statusOf(finding);
      issuesFound += 1;
      // Discovered-by-severity per day (all statuses) — the "issues over time" series.
      if (key in bucket) bucket[key as "critical" | "high" | "medium" | "low"] += 1;
      if (status === "fixed") {
        issuesFixed += 1;
        bucket.fixed += 1;
      } else if (status !== "ignored") {
        bucket.open += 1;
        if (key in severity) severity[key] += 1;
      }
    }
    byDay.set(day, bucket);
    if (job.status === "completed" && !job.blocking) verdicts.approved += 1;
    else if ((job.blocking ?? 0) > 0) verdicts.changesRequested += 1;
    else verdicts.commented += 1;
  }
  const repos = new Map<string, { repository: string; prs: number; findings: number; addressed: number }>();
  for (const job of recent) {
    if (!job.repo) continue;
    const row = repos.get(job.repo) ?? { repository: job.repo, prs: 0, findings: 0, addressed: 0 };
    row.prs += 1; row.findings += job.findings ?? 0;
    if (job.status === "completed" && !(job.blocking ?? 0)) row.addressed += job.findings ?? 0;
    repos.set(job.repo, row);
  }
  res.json({
    periodDays: days,
    metrics: {
      // Score + open counts reflect what is STILL open, so fixing issues improves them.
      securityScore: Math.max(0, 100 - severity.critical * 18 - severity.high * 8 - severity.medium * 3 - severity.low),
      openIssues: severity.critical + severity.high + severity.medium + severity.low,
      issuesFound,
      issuesFixed,
      fixRate: issuesFound ? Math.round((issuesFixed / issuesFound) * 100) : 100,
      prsReviewed: recent.length,
      pentests: recent.filter((job) => job.lens === "pentest").length,
    },
    severity, verdicts,
    history: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values })),
    repositories: [...repos.values()].sort((a, b) => b.findings - a.findings || b.prs - a.prs).slice(0, 8),
  });
});

/** GET /jobs/:id — only return a job from the active org. */
reviewsRouter.get("/jobs/:id", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const job = await (memoryEngine.store as Store).getMemoryJob?.(String(req.params.id));
  const input = (job?.input ?? {}) as { orgId?: unknown };
  if (!job || (input.orgId !== req.orgId) || !["pr-security-review", "pr-code-review", "pr-pentest", "domain-pentest"].includes(job.kind)) { sendError(res, 404, "Review job not found"); return; }
  res.json({ review: reviewRecord(job), canRun: await canRun(req) });
});

/** POST /run — validates installation access, audits requester, and refuses duplicate in-flight jobs. */
reviewsRouter.post("/run", async (req: AuthedRequest, res) => {
  if (!(await requireRun(req, res))) return;
  const repo = req.body?.repo;
  const prNumber = Number(req.body?.prNumber);
  const lens = req.body?.lens as Lens;
  const forge = req.body?.forge === "gitlab" ? "gitlab" : "github";
  if (!validRepo(repo, forge) || !Number.isInteger(prNumber) || prNumber <= 0 || !["security", "code", "pentest", "both"].includes(lens)) { sendError(res, 400, "repo, positive prNumber, and lens are required"); return; }
  const authorization = await manualReviewAuthorization(req.orgId!, req.userId!, repo, forge);
  if (!authorization) { sendError(res, 400, `Repository is not available through the connected ${forge === "gitlab" ? "GitLab" : "GitHub"} authorization`); return; }
  const requested = lens === "both" ? ["security", "code"] as const : [lens] as const;
  const store = memoryEngine.store as Store;
  const jobs: Array<{ id: string; lens: "security" | "code" | "pentest" }> = [];
  for (const one of requested) {
    const kind = one === "security" ? "pr-security-review" : one === "pentest" ? "pr-pentest" : "pr-code-review";
    const inflight = (await store.listMemoryJobs?.({ kind, status: ["pending", "running"], limit: 500 })) ?? [];
    const duplicate = inflight.find((job) => { const input = job.input as { orgId?: unknown; repo?: unknown; prNumber?: unknown; forge?: unknown }; return input.orgId === req.orgId && input.repo === repo && Number(input.prNumber) === prNumber && (input.forge === "gitlab" ? "gitlab" : "github") === forge; });
    if (duplicate) { jobs.push({ id: duplicate.id, lens: one }); continue; }
    const job = await store.enqueueMemoryJob?.({
      kind,
      input: {
        orgId: req.orgId!,
        forge,
        installationId: authorization.installationId,
        credentialSource: authorization.credentialSource,
        repo,
        prNumber,
        headSha: "",
        requestedBy: req.userId,
      },
      maxAttempts: 3,
    });
    if (job) jobs.push({ id: job.id, lens: one });
  }
  res.status(202).json({ jobs });
});

/** GET /prs — open GitHub PRs accessible to the active credential. GitHub
 * repository fan-out is bounded and stale-while-revalidate cached per user/org;
 * local review state is joined after the cache so running jobs remain live. */
reviewsRouter.get("/prs", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const repositoryAccess = await githubConsoleRepositories(req.orgId!, req.userId!);
  if (!repositoryAccess) { res.json({ prs: [], canRun: await canRun(req) }); return; }
  const { auth, repos } = repositoryAccess;
  // Account credentials are per-user. Include every non-secret authorization
  // boundary so private repository metadata can never cross users or sources.
  const cacheKey = [req.orgId!, req.userId!, auth.credentialSource, auth.installationId, auth.apiBase].join(":");
  const [github, stateContext, jobs, permission] = await Promise.all([
    pullRequestLoader.load({
      cacheKey,
      repos,
      force: req.query.refresh === "1",
      fetchRepo: async (repo, etag, signal) => {
        const response = await fetch(`${auth.apiBase}/repos/${repo}/pulls?state=open&per_page=50`, {
          headers: { ...ghHeaders(auth.token), ...(etag ? { "If-None-Match": etag } : {}) },
          signal,
        });
        if (response.status === 304) return { status: "not-modified", etag: response.headers.get("etag") ?? etag };
        if (!response.ok) throw new Error(`GitHub repository request failed (${response.status})`);
        const rows = (await response.json() as any[]).map((pr): GithubPrRow => ({
          repo,
          number: Number(pr.number),
          title: String(pr.title ?? "Untitled pull request"),
          author: pr.user?.login ? String(pr.user.login) : null,
          headSha: pr.head?.sha ? String(pr.head.sha) : null,
          updatedAt: pr.updated_at ? String(pr.updated_at) : null,
          createdAt: pr.created_at ? String(pr.created_at) : null,
          url: pr.html_url ? String(pr.html_url) : null,
          state: String(pr.state ?? "open"),
          draft: pr.draft === true,
          comments: Number(pr.comments ?? 0) + Number(pr.review_comments ?? 0),
          labels: Array.isArray(pr.labels) ? pr.labels.map((label: any) => String(label?.name ?? "")).filter(Boolean) : [],
        }));
        return { status: "ok", rows, etag: response.headers.get("etag") ?? undefined };
      },
    }),
    githubReviewStateContext(req.orgId!, req.userId!),
    (memoryEngine.store as Store).listReviewJobSummariesForOrg?.(req.orgId!, 2_000).then((value) => value ?? []) ?? Promise.resolve([]),
    canRun(req),
  ]);
  const latest = new Map<string, ReturnType<typeof reviewRecord>>();
  for (const job of jobs) { const rec = reviewRecord(job); const key = `${rec.repo}#${rec.prNumber}:${rec.lens}`; if (!latest.has(key)) latest.set(key, rec); }
  const prs = github.rows.map((pr) => ({
    ...pr,
    availability: reviewAvailability(stateContext, pr.repo, true),
    security: latest.get(`${pr.repo}#${pr.number}:security`) ?? null,
    code: latest.get(`${pr.repo}#${pr.number}:code`) ?? null,
  }));
  res.json({
    prs,
    canRun: permission,
    cache: { fresh: github.fresh, refreshing: github.refreshing },
    partial: github.partial,
    failedRepositories: github.failedRepositories,
  });
});

/** Local-only live activity. Safe to poll: performs no GitHub request. */
reviewsRouter.get("/prs/:owner/:repo/:number/activity", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const repo = `${req.params.owner}/${req.params.repo}`;
  const number = Number(req.params.number);
  if (!validRepo(repo) || !Number.isInteger(number) || number <= 0) { sendError(res, 400, "Invalid pull request"); return; }
  const jobs = (await (memoryEngine.store as Store).listReviewJobsForPr?.(req.orgId!, repo, number, 50)) ?? [];
  res.json({ reviews: jobs.map(reviewRecord), canRun: await canRun(req) });
});

/** GET /prs/:owner/:repo/:number — PR metadata, check-runs and both lens results. */
reviewsRouter.get("/prs/:owner/:repo/:number", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const repo = `${req.params.owner}/${req.params.repo}`;
  const number = Number(req.params.number);
  if (!validRepo(repo) || !Number.isInteger(number)) { sendError(res, 400, "Invalid pull request"); return; }
  const auth = await githubReviewAuthorization(req.orgId!, req.userId!, repo);
  if (!auth) { sendError(res, 404, "Pull request not found"); return; }
  try {
    const [pull, jobs, stateContext, permission] = await Promise.all([
      fetch(`${auth.apiBase}/repos/${repo}/pulls/${number}`, { headers: ghHeaders(auth.token), signal: AbortSignal.timeout(5_000) }),
      (memoryEngine.store as Store).listReviewJobsForPr?.(req.orgId!, repo, number, 50).then((value) => value ?? []) ?? Promise.resolve([]),
      githubReviewStateContext(req.orgId!, req.userId!),
      canRun(req),
    ]);
    if (!pull.ok) { sendError(res, pull.status === 404 ? 404 : 502, "Unable to load pull request"); return; }
    const pr = await pull.json() as any;
    const checks = pr.head?.sha ? await fetch(`${auth.apiBase}/repos/${repo}/commits/${pr.head.sha}/check-runs`, { headers: ghHeaders(auth.token), signal: AbortSignal.timeout(5_000) }).then(async (r) => r.ok ? ((await r.json() as any).check_runs ?? []) : []).catch(() => []) : [];
    res.json({ pr: { repo, number, title: pr.title, author: pr.user?.login ?? null, branch: pr.head?.ref ?? null, headSha: pr.head?.sha ?? null, url: pr.html_url ?? null, availability: reviewAvailability(stateContext, repo, true), checks, reviews: jobs.map(reviewRecord) }, canRun: permission });
  } catch { sendError(res, 502, "Unable to load pull request"); }
});
