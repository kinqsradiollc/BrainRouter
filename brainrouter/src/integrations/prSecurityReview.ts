/**
 * PR-security-review executor core (ADR-017 D5). Driven by a `pull_request`
 * webhook: mint the org's GitHub App installation token, fetch the PR diff, run
 * the read-only security reviewer over it, and post/update ONE idempotent PR
 * comment (keyed by a stable marker). Pure + dependency-injected (fetch / clock /
 * LLM / integration lookup) so it unit-tests without the network or a DB.
 *
 * Least privilege: only the installation token for this repo is used; secrets are
 * never echoed into the comment; the diff is capped before it reaches the model.
 */
import { mintInstallationToken, validateGithubApiBase } from '@kinqs/brainrouter-core/track';
import { buildSecurityReviewContract, formatSecurityReviewComment, parseReviewFindings, SECURITY_REVIEW_MARKER } from '@kinqs/brainrouter-core/review';
import type { LLMRunner } from '@kinqs/brainrouter-types';

export interface PrSecurityReviewInput {
  orgId?: string;
  installationId: string;
  repo: string; // "owner/name"
  prNumber: number;
  headSha: string;
}

export interface PrSecurityReviewDeps {
  llmRunner: LLMRunner;
  fetchImpl: typeof fetch;
  nowSec: () => number;
  /** Resolve the org's GitHub App creds for this installation (non-secret config + opened secret). */
  getIntegration: (installationId: string) => Promise<{ config: Record<string, unknown>; secret: Record<string, string> } | null>;
  /** Cap on the diff (chars) sent to the model — a huge PR must not blow the context. */
  maxDiffChars?: number;
}

export interface PrSecurityReviewResult { ok: boolean; findings: number; posted: boolean; skipped?: string; error?: string }

function ghHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

export async function runPrSecurityReview(input: PrSecurityReviewInput, deps: PrSecurityReviewDeps): Promise<PrSecurityReviewResult> {
  const repo = String(input.repo ?? '').trim();
  const prNumber = Number(input.prNumber);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, findings: 0, posted: false, skipped: 'bad-input' };
  }

  const integ = await deps.getIntegration(String(input.installationId));
  if (!integ) return { ok: false, findings: 0, posted: false, skipped: 'no-integration' };
  const appId = String(integ.config.appId ?? '').trim();
  const privateKey = String(integ.secret.privateKey ?? '').trim();
  const apiBase = validateGithubApiBase(typeof integ.config.apiBase === 'string' ? integ.config.apiBase : '') ?? 'https://api.github.com';
  if (!appId || !privateKey) return { ok: false, findings: 0, posted: false, skipped: 'no-app-creds' };

  let token: string;
  try {
    token = (await mintInstallationToken({ appId, privateKey, apiBase }, String(input.installationId), { fetchImpl: deps.fetchImpl as never, nowSec: deps.nowSec })).token;
  } catch (e) { return { ok: false, findings: 0, posted: false, error: e instanceof Error ? e.message : 'token mint failed' }; }

  // 1. Fetch the unified diff for the PR.
  let diff = '';
  try {
    const r = await deps.fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}`, { headers: ghHeaders(token, 'application/vnd.github.diff') });
    if (!r.ok) return { ok: false, findings: 0, posted: false, error: `diff HTTP ${r.status}` };
    diff = await r.text();
  } catch (e) { return { ok: false, findings: 0, posted: false, error: e instanceof Error ? e.message : 'diff fetch failed' }; }
  if (!diff.trim()) return { ok: true, findings: 0, posted: false, skipped: 'empty-diff' };

  // 2. Run the read-only security reviewer over the diff.
  const cap = deps.maxDiffChars ?? 60_000;
  const prompt = `You are reviewing pull request #${prNumber} in ${repo}. Here is the unified diff:\n\n\`\`\`diff\n${diff.slice(0, cap)}\n\`\`\`\n\n${buildSecurityReviewContract()}`;
  let reviewText = '';
  try {
    reviewText = await deps.llmRunner.run({ prompt, systemPrompt: 'You are a meticulous application-security reviewer for pull requests.', taskId: `pr-security-review:${repo}#${prNumber}`, timeoutMs: 120_000 });
  } catch (e) { return { ok: false, findings: 0, posted: false, error: e instanceof Error ? e.message : 'review failed' }; }
  const findings = parseReviewFindings(reviewText);

  // 3. Post/update ONE idempotent comment (keyed by the marker, per PR head).
  const body = formatSecurityReviewComment({ findings, headSha: String(input.headSha ?? '') });
  const posted = await upsertReviewComment(deps.fetchImpl, apiBase, repo, prNumber, body, token);
  return { ok: true, findings: findings.length, posted };
}

/** Find our previous comment (by {@link SECURITY_REVIEW_MARKER}) and PATCH it; else POST a new one. */
async function upsertReviewComment(fetchImpl: typeof fetch, apiBase: string, repo: string, prNumber: number, body: string, token: string): Promise<boolean> {
  try {
    const list = await fetchImpl(`${apiBase}/repos/${repo}/issues/${prNumber}/comments?per_page=100`, { headers: ghHeaders(token) });
    if (list.ok) {
      const arr = (await list.json()) as Array<{ id?: number; body?: string }>;
      const mine = (Array.isArray(arr) ? arr : []).find((c) => typeof c.body === 'string' && c.body.includes(SECURITY_REVIEW_MARKER));
      if (mine?.id) {
        const patch = await fetchImpl(`${apiBase}/repos/${repo}/issues/comments/${mine.id}`, {
          method: 'PATCH', headers: { ...ghHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        });
        return patch.ok;
      }
    }
    const create = await fetchImpl(`${apiBase}/repos/${repo}/issues/${prNumber}/comments`, {
      method: 'POST', headers: { ...ghHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
    });
    return create.ok;
  } catch { return false; }
}
