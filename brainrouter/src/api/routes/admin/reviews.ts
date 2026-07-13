/** PR review console API: org-scoped jobs, manual runs, GitHub PR metadata and timelines. */
import { Router } from "express";
import { mintInstallationToken, validateGithubApiBase } from "@kinqs/brainrouter-core/track";
import type { MemoryJobRecord, ReviewJobDto } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { attachOrgContext, requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { can } from "../../../tenancy/rbac.js";
import { canAccessGithubRepository, isRepoAvailableForManualReview, isRepoLinkedForReview } from "../../../integrations/githubWebhook.js";
import { resolveGithubAccountToken } from "../../../connectors/githubAccountToken.js";

export const reviewsRouter = Router();
reviewsRouter.use(requireAnyAuth);

type Store = Partial<{
  listReviewJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]>;
  getMemoryJob(id: string): Promise<MemoryJobRecord | null>;
  listMemoryJobs(filters?: { kind?: string; status?: string[]; limit?: number }): Promise<MemoryJobRecord[]>;
  enqueueMemoryJob(input: { kind: string; input: Record<string, unknown>; maxAttempts?: number }): Promise<MemoryJobRecord>;
}>;
type Lens = "security" | "code" | "pentest" | "both";
const cache = new Map<string, { until: number; prs: unknown[] }>();

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
  try {
    const app = await githubToken(orgId);
    if (app && await isRepoAvailableForManualReview(app.integ.config, repo, { apiBase: app.apiBase, token: app.token })) {
      return { credentialSource: "github_app", installationId: app.installationId };
    }
  } catch { /* a broken optional App integration must not mask a healthy account connector */ }

  const account = await resolveGithubAccountToken(memoryEngine.emailAuth, userId);
  if (account && await canAccessGithubRepository(repo, { apiBase: "https://api.github.com", token: account.accessToken })) {
    return { credentialSource: "github_account", installationId: "" };
  }
  return null;
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

/** GET /jobs — compact recent list; developer-readable. */
reviewsRouter.get("/jobs", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const jobs = (await (memoryEngine.store as Store).listReviewJobsForOrg?.(req.orgId!, limit)) ?? [];
  res.json({ reviews: jobs.map(reviewRecord), canRun: await canRun(req) });
});

/** GET /summary — analytics-friendly rollup for the dashboard.  The raw jobs
 * remain the source of truth; this route keeps the browser from reimplementing
 * time bucketing and severity parsing on every render. */
reviewsRouter.get("/summary", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
  const jobs = (await (memoryEngine.store as Store).listReviewJobsForOrg?.(req.orgId!, 500)) ?? [];
  const since = Date.now() - days * 86_400_000;
  const recent = jobs.map(reviewRecord).filter((job) => Date.parse(job.createdAt) >= since);
  const severity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const verdicts = { approved: 0, commented: 0, changesRequested: 0 };
  const byDay = new Map<string, { critical: number; high: number; medium: number; low: number }>();
  for (const job of recent) {
    const day = job.createdAt.slice(0, 10);
    const bucket = byDay.get(day) ?? { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of job.findingsDetail ?? []) {
      const key = String(finding.severity ?? "").toLowerCase() as keyof typeof severity;
      if (key in severity) severity[key] += 1;
      if (key in bucket) bucket[key as keyof typeof bucket] += 1;
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
  const totalFindings = Object.values(severity).reduce((a, b) => a + b, 0);
  res.json({
    periodDays: days,
    metrics: { securityScore: Math.max(0, 100 - severity.critical * 18 - severity.high * 8 - severity.medium * 3 - severity.low), openIssues: severity.critical + severity.high + severity.medium + severity.low, issuesFound: totalFindings, fixRate: totalFindings ? Math.round(([...repos.values()].reduce((n, r) => n + r.addressed, 0) / totalFindings) * 100) : 100, prsReviewed: recent.length, pentests: recent.filter((job) => job.lens === "pentest").length },
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

/** GET /prs — open GitHub PRs on linked repositories, cached per-org for 30 seconds. */
reviewsRouter.get("/prs", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const cached = cache.get(req.orgId!);
  if (cached && cached.until > Date.now()) { res.json({ prs: cached.prs, canRun: await canRun(req) }); return; }
  const auth = await githubToken(req.orgId!);
  if (!auth) { res.json({ prs: [], canRun: await canRun(req) }); return; }
  const linked = auth.integ.config.linkedRepositories;
  let repos = Array.isArray(linked) ? linked.map(String) : [];
  if (!Array.isArray(linked)) {
    try {
      const response = await fetch(`${auth.apiBase}/installation/repositories?per_page=100`, { headers: ghHeaders(auth.token) });
      if (response.ok) repos = ((await response.json() as { repositories?: Array<{ full_name?: string }> }).repositories ?? []).map((repo) => String(repo.full_name ?? "")).filter((repo) => validRepo(repo));
    } catch { /* a console read should degrade to an empty PR list */ }
  }
  const jobs = (await (memoryEngine.store as Store).listReviewJobsForOrg?.(req.orgId!, 500)) ?? [];
  const latest = new Map<string, ReturnType<typeof reviewRecord>>();
  for (const job of jobs) { const rec = reviewRecord(job); const key = `${rec.repo}#${rec.prNumber}:${rec.lens}`; if (!latest.has(key)) latest.set(key, rec); }
  const prs: any[] = [];
  for (const repo of repos) {
    try {
      const response = await fetch(`${auth.apiBase}/repos/${repo}/pulls?state=open&per_page=50`, { headers: ghHeaders(auth.token) });
      if (!response.ok) continue;
      for (const pr of await response.json() as any[]) prs.push({ repo, number: pr.number, title: pr.title, author: pr.user?.login ?? null, headSha: pr.head?.sha ?? null, updatedAt: pr.updated_at ?? null, url: pr.html_url ?? null, security: latest.get(`${repo}#${pr.number}:security`) ?? null, code: latest.get(`${repo}#${pr.number}:code`) ?? null });
    } catch { /* one inaccessible repo must not hide others */ }
  }
  cache.set(req.orgId!, { until: Date.now() + 30_000, prs });
  res.json({ prs, canRun: await canRun(req) });
});

/** GET /prs/:owner/:repo/:number — PR metadata, check-runs and both lens results. */
reviewsRouter.get("/prs/:owner/:repo/:number", requirePermission("reviews:read"), async (req: AuthedRequest, res) => {
  const repo = `${req.params.owner}/${req.params.repo}`;
  const number = Number(req.params.number);
  if (!validRepo(repo) || !Number.isInteger(number)) { sendError(res, 400, "Invalid pull request"); return; }
  const auth = await githubToken(req.orgId!);
  if (!auth || !isRepoLinkedForReview(auth.integ.config, repo)) { sendError(res, 404, "Pull request not found"); return; }
  try {
    const pull = await fetch(`${auth.apiBase}/repos/${repo}/pulls/${number}`, { headers: ghHeaders(auth.token) });
    if (!pull.ok) { sendError(res, pull.status === 404 ? 404 : 502, "Unable to load pull request"); return; }
    const pr = await pull.json() as any;
    const checks = pr.head?.sha ? await fetch(`${auth.apiBase}/repos/${repo}/commits/${pr.head.sha}/check-runs`, { headers: ghHeaders(auth.token) }).then(async (r) => r.ok ? ((await r.json() as any).check_runs ?? []) : []).catch(() => []) : [];
    const jobs = (await (memoryEngine.store as Store).listReviewJobsForOrg?.(req.orgId!, 500)) ?? [];
    const matching = jobs.filter((job) => { const input = job.input as { repo?: unknown; prNumber?: unknown }; return input.repo === repo && Number(input.prNumber) === number; }).map(reviewRecord);
    res.json({ pr: { repo, number, title: pr.title, author: pr.user?.login ?? null, branch: pr.head?.ref ?? null, headSha: pr.head?.sha ?? null, url: pr.html_url ?? null, checks, reviews: matching }, canRun: await canRun(req) });
  } catch { sendError(res, 502, "Unable to load pull request"); }
});
