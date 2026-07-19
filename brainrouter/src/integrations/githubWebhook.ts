/**
 * GitHub webhook core (ADR-010 P6b) — shared by the in-brain route AND the
 * standalone ingress microservice. Pure + dependency-injected so it unit-tests
 * without a server or a DB: verify the App's HMAC, resolve the tenant from the
 * installation, enqueue tenant-tagged. No Express, no engine — just the logic.
 */
import crypto from "node:crypto";
import type { ResolvedIntegration } from "./types.js";
import { mintInstallationToken, validateGithubApiBase } from "@kinqs/brainrouter-core/track";

/** Constant-time verify of GitHub's `sha256=<hex>` HMAC over the raw body. */
export function verifyGithubSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !raw || raw.length === 0) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface WebhookDeps {
  findIntegrationByInstallation(installationId: string): Promise<(ResolvedIntegration & { orgId: string }) | null>;
  enqueue(job: { kind: string; input: Record<string, unknown> }): Promise<void>;
  /** Injectable for permission-gate tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
}

/**
 * Is this repo LINKED in our system for review? Gates the bot to repos the org opted in —
 * like the rest of BrainRouter's per-repo scoping. The allowlist lives on the org's
 * `github_app` integration config (`linkedRepositories: string[]`), set from the dashboard.
 * ABSENT field → review every installed repo (back-compat: don't silently stop a working
 * bot); PRESENT (even empty) → only the listed repos are reviewed.
 */
export function isRepoLinkedForReview(config: Record<string, unknown> | undefined, repoFullName: string): boolean {
  const raw = config?.linkedRepositories;
  if (!Array.isArray(raw)) return true; // never configured → review all (opt-out model)
  const normalizedRepo = repoFullName.trim().toLowerCase();
  return raw.some((value) => String(value).trim().toLowerCase() === normalizedRepo);
}

/** Per-repo review behavior (Strix-style Approve / Block / Re-review), resolved per PR. */
export interface ReviewPolicy {
  /** Post an APPROVE review when a lens finds nothing (vs. a silent pass). */
  approveClean: boolean;
  /** A blocking finding fails the check-run (gates merge). Off ⇒ neutral (advisory only). */
  blockOnFindings: boolean;
  /** Re-run the review on every push (pull_request.synchronize). Off ⇒ only on open/reopen. */
  reReviewOnPush: boolean;
  /** Code review is command-driven by default; opt in to auto review per repo. */
  codeReviewTrigger: "auto" | "manual";
}

const REVIEW_POLICY_DEFAULTS: ReviewPolicy = { approveClean: false, blockOnFindings: true, reReviewOnPush: true, codeReviewTrigger: "manual" };

/**
 * Resolve the effective review policy for a repo: a per-repo override
 * (`config.reviewPolicies[repo]`) falls back to the org default
 * (`config.reviewPolicyDefaults`), which falls back to the built-in defaults. Each field
 * is resolved independently so "Default" on one toggle doesn't reset the others.
 */
export function resolveReviewPolicy(config: Record<string, unknown> | undefined, repoFullName: string): ReviewPolicy {
  const defaults = (config?.reviewPolicyDefaults ?? {}) as Partial<ReviewPolicy>;
  const perRepo = (((config?.reviewPolicies ?? {}) as Record<string, Partial<ReviewPolicy>>)[repoFullName]) ?? {};
  const pick = (k: "approveClean" | "blockOnFindings" | "reReviewOnPush"): boolean => {
    const v = perRepo[k] ?? defaults[k];
    return typeof v === "boolean" ? v : REVIEW_POLICY_DEFAULTS[k];
  };
  const trigger = perRepo.codeReviewTrigger ?? defaults.codeReviewTrigger;
  return {
    approveClean: pick("approveClean"),
    blockOnFindings: pick("blockOnFindings"),
    reReviewOnPush: pick("reReviewOnPush"),
    codeReviewTrigger: trigger === "auto" ? "auto" : "manual",
  };
}

export type ReviewCommand = "security" | "code" | "both";

/** Parse only supported PR commands; legacy /review never consumes /code-review. */
export function parseReviewCommand(body: string): ReviewCommand | null {
  const text = String(body ?? "");
  if (/(^|\s)\/security-review\b/i.test(text) || /@\S*brainrouter\S*\s+security-review\b/i.test(text)) return "security";
  if (/(^|\s)\/code-review\b/i.test(text) || /@\S*brainrouter\S*\s+code-review\b/i.test(text)) return "code";
  if (/(^|\s)\/review(?!-)\b/i.test(text) || /@\S*brainrouter\S*\s+review(?!-)\b/i.test(text)) return "both";
  return null;
}

type GithubPermission = "admin" | "maintain" | "write" | "read" | "none";
const PERMISSION_RANK: Record<GithubPermission, number> = { none: 0, read: 1, write: 2, maintain: 3, admin: 4 };

function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

/**
 * Manual reviews are already gated by org RBAC. An explicit linkedRepositories
 * list continues to control automatic webhook reviews, but it must not strand a
 * maintainer manually reviewing a repository that the same GitHub App
 * installation can access. Verify installation access with GitHub before
 * allowing that manual run; failures stay closed.
 */
export async function isRepoAvailableForManualReview(
  config: Record<string, unknown> | undefined,
  repoFullName: string,
  auth: { apiBase: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (isRepoLinkedForReview(config, repoFullName)) return true;
  return canAccessGithubRepository(repoFullName, auth, fetchImpl);
}

/** Confirm that one concrete GitHub credential can reach a repository. */
export async function canAccessGithubRepository(
  repoFullName: string,
  auth: { apiBase: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const [owner, repo, ...extra] = repoFullName.split("/");
  const apiBase = validateGithubApiBase(auth.apiBase);
  if (!owner || !repo || extra.length || !apiBase || !auth.token) return false;
  try {
    const response = await fetchImpl(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: githubHeaders(auth.token),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Server-side repository-permission lookup for comment commands. */
export async function resolveCommenterPermission(
  fetchImpl: typeof fetch, apiBase: string, repo: string, username: string, token: string,
): Promise<GithubPermission> {
  try {
    const res = await fetchImpl(`${apiBase}/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`, { headers: githubHeaders(token) });
    if (!res.ok) return "none";
    const json = await res.json() as { permission?: unknown };
    const permission = String(json.permission ?? "none").toLowerCase();
    return permission in PERMISSION_RANK ? permission as GithubPermission : "none";
  } catch { return "none"; }
}

async function commentCommandAllowed(
  deps: WebhookDeps, integ: ResolvedIntegration & { orgId: string }, repo: string, username: string,
): Promise<boolean> {
  const config = integ.config ?? {};
  const runners = (config.manualReviewRunners ?? {}) as { minPermission?: unknown; allowlist?: unknown };
  const allowlist = Array.isArray(runners.allowlist) ? runners.allowlist.map((x) => String(x).toLowerCase()) : [];
  if (allowlist.includes(username.toLowerCase())) return true;
  const min = runners.minPermission === "admin" || runners.minPermission === "write" || runners.minPermission === "maintain"
    ? runners.minPermission : "maintain";
  const appId = String(config.appId ?? "").trim();
  const privateKey = String(integ.secret?.privateKey ?? "").trim();
  const installationId = String(config.installationId ?? "").trim();
  if (!appId || !privateKey || !installationId) return false;
  const apiBase = validateGithubApiBase(typeof config.apiBase === "string" ? config.apiBase : "") ?? "https://api.github.com";
  try {
    const token = await mintInstallationToken({ appId, privateKey, apiBase }, installationId, {
      fetchImpl: (deps.fetchImpl ?? fetch) as never,
      nowSec: deps.nowSec ?? (() => Math.floor(Date.now() / 1000)),
    });
    return PERMISSION_RANK[await resolveCommenterPermission(deps.fetchImpl ?? fetch, apiBase, repo, username, token.token)] >= PERMISSION_RANK[min];
  } catch { return false; }
}

async function postDeniedReply(deps: WebhookDeps, integ: ResolvedIntegration & { orgId: string }, repo: string, prNumber: number, username: string): Promise<void> {
  const config = integ.config ?? {};
  const appId = String(config.appId ?? "").trim();
  const privateKey = String(integ.secret?.privateKey ?? "").trim();
  const installationId = String(config.installationId ?? "").trim();
  if (!appId || !privateKey || !installationId) return;
  const apiBase = validateGithubApiBase(typeof config.apiBase === "string" ? config.apiBase : "") ?? "https://api.github.com";
  const marker = "<!-- brainrouter-review-command-denied -->";
  try {
    const token = await mintInstallationToken({ appId, privateKey, apiBase }, installationId, { fetchImpl: (deps.fetchImpl ?? fetch) as never, nowSec: deps.nowSec ?? (() => Math.floor(Date.now() / 1000)) });
    const list = await (deps.fetchImpl ?? fetch)(`${apiBase}/repos/${repo}/issues/${prNumber}/comments?per_page=100`, { headers: githubHeaders(token.token) });
    if (list.ok && (await list.json() as Array<{ body?: string }>).some((comment) => comment.body?.includes(marker))) return;
    const min = ((config.manualReviewRunners ?? {}) as { minPermission?: unknown }).minPermission;
    const required = min === "admin" || min === "write" || min === "maintain" ? min : "maintain";
    await (deps.fetchImpl ?? fetch)(`${apiBase}/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST", headers: { ...githubHeaders(token.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: `${marker}\n@${username} you need ${required} access to run reviews.` }),
    });
  } catch { /* permission denial must never fail a webhook */ }
}

export interface WebhookRequest {
  body: Record<string, any>;
  rawBody: Buffer;
  signature?: string;
  event?: string;
  delivery?: string;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Process one GitHub delivery. Unknown/unsigned → generic 202 (no
 * installation-existence leak); signature mismatch on a KNOWN installation → 401;
 * valid → enqueue + 202.
 */
export async function processGithubDelivery(deps: WebhookDeps, req: WebhookRequest): Promise<WebhookResponse> {
  const installationId = String(req.body?.installation?.id ?? "").trim();
  if (!installationId) return { status: 202, body: { ok: true, skipped: "no-installation" } };

  let integ: (ResolvedIntegration & { orgId: string }) | null = null;
  try { integ = await deps.findIntegrationByInstallation(installationId); } catch { /* → generic 202 */ }
  if (!integ) return { status: 202, body: { ok: true, skipped: "unknown-installation" } };

  const secret = typeof integ.secret?.webhookSecret === "string" ? integ.secret.webhookSecret : "";
  if (!verifyGithubSignature(secret, req.rawBody, req.signature)) {
    return { status: 401, body: { error: "invalid webhook signature", code: "unauthorized" } };
  }

  try {
    await deps.enqueue({
      kind: "trigger.github",
      input: {
        orgId: integ.orgId,
        installationId,
        event: req.event,
        delivery: req.delivery,
        repo: req.body?.repository?.full_name,
        number: req.body?.issue?.number ?? req.body?.pull_request?.number,
        action: req.body?.action,
      },
    });
  } catch { /* best-effort; the endpoint still acks */ }

  // PR reviews are independent jobs. Security is always automatic; code review is
  // manual by default and can be opted into automatic runs per repository.
  const action = String(req.body?.action ?? "");
  const orgId = integ.orgId;
  const repoFullName = req.body?.repository?.full_name;
  const repoLinked = isRepoLinkedForReview(integ.config, String(repoFullName ?? ""));
  const fireReviews = async (
    prNumber: unknown,
    headSha: unknown,
    lenses: Array<"security" | "code">,
    identities: { prAuthor?: unknown; triggeredByLogin?: unknown } = {},
  ) => {
    if (!repoLinked) return; // repo not linked to our system → do not review
    const prAuthor = typeof identities.prAuthor === "string" ? identities.prAuthor.trim() : "";
    const triggeredByLogin = typeof identities.triggeredByLogin === "string" ? identities.triggeredByLogin.trim() : "";
    const reviewInput = {
      orgId, installationId, repo: repoFullName, prNumber, headSha,
      ...(prAuthor ? { prAuthor } : {}),
      ...(triggeredByLogin ? { triggeredByLogin } : {}),
    };
    for (const lens of lenses) {
      try {
        await deps.enqueue({ kind: lens === "security" ? "pr-security-review" : "pr-code-review", input: reviewInput });
      } catch { /* best-effort; each lens is independent */ }
    }
  };

  // Security runs on open/reopen and configured pushes. Code only joins automatic
  // events when the repo explicitly opts into `codeReviewTrigger: auto`.
  if (req.event === "pull_request" && (action === "opened" || action === "synchronize" || action === "reopened")) {
    const pr = (req.body?.pull_request ?? {}) as { number?: number; head?: { sha?: string }; user?: { login?: string } };
    const policy = resolveReviewPolicy(integ.config, String(repoFullName ?? ""));
    const isPush = action === "synchronize";
    const lenses: Array<"security" | "code"> = [];
    if (!isPush || policy.reReviewOnPush) lenses.push("security");
    if (policy.codeReviewTrigger === "auto" && (!isPush || policy.reReviewOnPush)) lenses.push("code");
    if (lenses.length) await fireReviews(pr.number, pr.head?.sha, lenses, {
      prAuthor: pr.user?.login,
      triggeredByLogin: req.body?.sender?.login,
    });
  }

  // Command runs are gated by the install token's repository permission, never by
  // GitHub's user-controlled author_association field.
  if (req.event === "issue_comment" && action === "created" && req.body?.issue?.pull_request) {
    const command = parseReviewCommand(String(req.body?.comment?.body ?? ""));
    const commenter = req.body?.comment?.user as { login?: unknown; type?: unknown } | undefined;
    const username = typeof commenter?.login === "string" ? commenter.login.trim() : "";
    if (command && username && String(commenter?.type ?? "").toLowerCase() !== "bot") {
      const allowed = await commentCommandAllowed(deps, integ, String(repoFullName ?? ""), username);
      if (!allowed) await postDeniedReply(deps, integ, String(repoFullName ?? ""), Number(req.body?.issue?.number), username);
      else await fireReviews(
        req.body?.issue?.number,
        "",
        command === "both" ? ["security", "code"] : [command],
        { triggeredByLogin: username },
      );
    }
  }

  return { status: 202, body: { ok: true, orgId } };
}
