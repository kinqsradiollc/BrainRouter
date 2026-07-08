/**
 * GitHub webhook core (ADR-010 P6b) — shared by the in-brain route AND the
 * standalone ingress microservice. Pure + dependency-injected so it unit-tests
 * without a server or a DB: verify the App's HMAC, resolve the tenant from the
 * installation, enqueue tenant-tagged. No Express, no engine — just the logic.
 */
import crypto from "node:crypto";
import type { ResolvedIntegration } from "./types.js";

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
  return raw.map(String).includes(repoFullName);
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

  // ADR-017 D5 — PR reviews fan out to both lenses, each a headless job that posts back
  // via the installation token: a SECURITY lens (vulnerabilities) + a general CODE-REVIEW
  // lens (correctness / clarity / architecture / perf / tests). Only repos LINKED in our
  // system are reviewed (like the rest of BrainRouter's repo scoping); unlinked repos are
  // ignored even though the App can see all of them.
  const action = String(req.body?.action ?? "");
  const orgId = integ.orgId;
  const repoFullName = req.body?.repository?.full_name;
  const repoLinked = isRepoLinkedForReview(integ.config, String(repoFullName ?? ""));
  const fireReviews = async (prNumber: unknown, headSha: unknown) => {
    if (!repoLinked) return; // repo not linked to our system → do not review
    const reviewInput = { orgId, installationId, repo: repoFullName, prNumber, headSha };
    for (const kind of ["pr-security-review", "pr-code-review"] as const) {
      try {
        await deps.enqueue({ kind, input: reviewInput });
      } catch { /* best-effort; each lens is independent */ }
    }
  };

  // A PR open/update auto-reviews with both lenses.
  if (req.event === "pull_request" && (action === "opened" || action === "synchronize" || action === "reopened")) {
    const pr = (req.body?.pull_request ?? {}) as { number?: number; head?: { sha?: string } };
    await fireReviews(pr.number, pr.head?.sha);
  }

  // Re-run on demand: a `/review` or `@brainrouter review` comment on a PR re-triggers both
  // lenses (Strix-style "Re-run review"). issue_comment carries no head SHA, so the executor
  // resolves it from the PR.
  if (req.event === "issue_comment" && action === "created" && req.body?.issue?.pull_request) {
    const body = String(req.body?.comment?.body ?? "");
    const isReviewCmd =
      /(^|\s)\/review\b/i.test(body) || /@\S*brainrouter\S*\s+review\b/i.test(body) || /\bbrainrouter\s+review\b/i.test(body);
    if (isReviewCmd) await fireReviews(req.body?.issue?.number, "");
  }

  return { status: 202, body: { ok: true, orgId } };
}
