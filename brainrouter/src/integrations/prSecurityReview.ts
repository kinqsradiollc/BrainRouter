/**
 * PR-review executor core (ADR-017 D5). Driven by a `pull_request` webhook, it runs a
 * single review LENS over the PR's unified diff — a SECURITY lens (vulnerabilities) and
 * a general CODE-REVIEW lens (correctness / clarity / architecture / perf / tests) —
 * and posts back like a human reviewer: a grouped PR review with inline ```suggestion
 * comments, an idempotent pinned summary, and a gating check-run. Pure + dependency-
 * injected (fetch / clock / LLM / integration lookup) so it unit-tests without the
 * network or a DB. The lens is the ONLY thing that varies between review kinds — see
 * `@kinqs/brainrouter-core/review` (reviewLens.ts).
 *
 * Least privilege: only the installation token for this repo is used; secrets are never
 * echoed into a comment; the diff is capped before it reaches the model.
 */
import { mintInstallationToken, validateGithubApiBase } from '@kinqs/brainrouter-core/track';
import {
  addedLinesByPath,
  buildReviewIntro,
  CODE_REVIEW_LENS,
  formatInlineFinding,
  formatReviewSummaryComment,
  inlineFindingMarker,
  inlineMarkerRegex,
  parseReviewFindings,
  PENTEST_LENS,
  resolveInlineAnchor,
  SECURITY_LENS,
  stripReasoning,
  formatVulnerabilityIntelligenceContext,
  type ParsedReviewFinding,
  type ReviewLens,
  type VulnerabilityIntelligenceResult,
} from '@kinqs/brainrouter-core/review';
import type { LLMRunner } from '@kinqs/brainrouter-types';
import { resolveReviewPolicy } from './githubWebhook.js';

export interface PrReviewInput {
  orgId?: string;
  forge?: "github" | "gitlab";
  installationId: string;
  /** Webhooks use the org App installation; manual desktop/dashboard runs may
   * reuse the requester's already-connected GitHub account authorization. */
  credentialSource?: "github_app" | "github_account" | "gitlab_account";
  requestedBy?: string;
  repo: string; // "owner/name"
  prNumber: number;
  headSha: string;
}

export interface PrReviewDeps {
  llmRunner: LLMRunner;
  fetchImpl: typeof fetch;
  nowSec: () => number;
  /** Resolve the org's GitHub App creds for this installation (non-secret config + opened secret). */
  getIntegration: (installationId: string) => Promise<{ config: Record<string, unknown>; secret: Record<string, string> } | null>;
  /** Resolve a manual review requester's sealed GitHub connector credential. */
  getUserAuthorization?: (userId: string) => Promise<{ token: string; apiBase: string; config?: Record<string, unknown> } | null>;
  /** Resolve a manual review requester's org-pinned sealed GitLab connector. */
  getGitlabAuthorization?: (userId: string, orgId: string) => Promise<{ token: string; apiBase: string; config?: Record<string, unknown> } | null>;
  /** Cap on the diff (chars) sent to the model — a huge PR must not blow the context. */
  maxDiffChars?: number;
  timeoutMs?: number;
  /** Best-effort durable job activity callback (must never affect review output). */
  onProgress?: (event: { kind: string; msg: string; data?: Record<string, unknown> }) => void;
  /**
   * Best-effort current vulnerability catalog. Injected by the worker so unit
   * tests never use the network and an unavailable feed never blocks reviews.
   */
  getVulnerabilityIntelligence?: () => Promise<VulnerabilityIntelligenceResult | null>;
}

export interface PrReviewFindingDetail {
  file: string;
  line?: number;
  severity: string;
  title: string;
  cwe?: string;
  preExisting?: boolean;
  suggestable?: boolean;
}

export interface PrReviewResult {
  ok: boolean;
  findings: number;
  /** Findings that block the merge (drive the check-run conclusion). */
  blocking?: number;
  posted: boolean;
  /** Inline review comments (with suggestions) newly posted this run. */
  inlinePosted?: number;
  /** Whether the grouped PR review was posted. */
  reviewPosted?: boolean;
  /** Whether a gating check-run was posted (requires the App's `checks: write`). */
  checkPosted?: boolean;
  /** Whether an APPROVE review was posted (repo policy `approveClean` + a clean lens). */
  approved?: boolean;
  skipped?: string;
  error?: string;
  /** Compact, non-sensitive finding projection for the PR console. */
  findingsDetail?: PrReviewFindingDetail[];
}

// Back-compat aliases (the security lens was the original single kind).
export type PrSecurityReviewInput = PrReviewInput;
export type PrSecurityReviewDeps = PrReviewDeps;
export type PrSecurityReviewResult = PrReviewResult;

function ghHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

function glHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

/**
 * Fetch a PR's unified diff from GitHub, resilient to large PRs.
 *
 * The compact `application/vnd.github.diff` media type is the fast path, but
 * GitHub returns **406 Not Acceptable** for it once a PR's diff is too large
 * (hundreds of files / tens of thousands of lines) — which silently killed the
 * review agent on big PRs. On 406 we fall back to the paginated Files API and
 * reconstruct a unified diff from each file's `patch` (the same shape the GitLab
 * branch builds). Binary / per-file-too-large entries have no `patch` and are
 * skipped (there is nothing textual to review). Returns the status on failure so
 * the caller can surface `diff HTTP <status>` unchanged.
 */
async function fetchGithubUnifiedDiff(
  fetchImpl: typeof fetch, apiBase: string, repo: string, prNumber: number, token: string,
): Promise<{ ok: true; diff: string } | { ok: false; status: number }> {
  const direct = await fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}`, { headers: ghHeaders(token, 'application/vnd.github.diff') });
  if (direct.ok) return { ok: true, diff: await direct.text() };
  if (direct.status !== 406) return { ok: false, status: direct.status };
  // Oversized diff → reconstruct from the Files API (max 3000 files, 100/page).
  const parts: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`, { headers: ghHeaders(token) });
    if (!r.ok) return { ok: false, status: r.status };
    const files = await r.json() as Array<{ filename?: string; previous_filename?: string; patch?: string }>;
    if (!Array.isArray(files) || files.length === 0) break;
    for (const f of files) {
      if (typeof f.patch !== 'string' || !f.patch) continue;
      const newPath = String(f.filename ?? 'unknown');
      const oldPath = String(f.previous_filename ?? f.filename ?? 'unknown');
      parts.push(`diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n${f.patch}`);
    }
    if (files.length < 100) break;
  }
  return { ok: true, diff: parts.join('\n') };
}

type GitlabDiffRefs = { base_sha?: string; start_sha?: string; head_sha?: string };

function validReviewRepo(repo: string, forge: "github" | "gitlab"): boolean {
  const parts = repo.split('/');
  return parts.length >= 2 && (forge === 'gitlab' || parts.length === 2)
    && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

/** Run the SECURITY lens over a PR (webhook `pr-security-review` job). */
export function runPrSecurityReview(input: PrReviewInput, deps: PrReviewDeps): Promise<PrReviewResult> {
  return runPrReview(input, deps, SECURITY_LENS);
}

/** Run the general CODE-REVIEW lens over a PR (webhook `pr-code-review` job). */
export function runPrCodeReview(input: PrReviewInput, deps: PrReviewDeps): Promise<PrReviewResult> {
  return runPrReview(input, deps, CODE_REVIEW_LENS);
}

/** Run the pentest lens against an explicitly linked repository.  Network probes
 * are deliberately unavailable in this PR path; it is an authorized white-box
 * assessment sharing the same reporting, audit, and merge-gate infrastructure. */
export function runPrPentest(input: PrReviewInput, deps: PrReviewDeps): Promise<PrReviewResult> {
  return runPrReview(input, deps, PENTEST_LENS);
}

/** Run one review lens end-to-end: diff → LLM → inline suggestions + summary + check-run. */
export async function runPrReview(input: PrReviewInput, deps: PrReviewDeps, lens: ReviewLens): Promise<PrReviewResult> {
  const progress = (kind: string, msg: string, data?: Record<string, unknown>) => {
    try { deps.onProgress?.({ kind, msg, ...(data ? { data } : {}) }); } catch { /* observability is best effort */ }
  };
  progress("queued", `${lens.name} review started`);
  const repo = String(input.repo ?? '').trim();
  const prNumber = Number(input.prNumber);
  const forge = input.forge === 'gitlab' ? 'gitlab' : 'github';
  if (!validReviewRepo(repo, forge) || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, findings: 0, posted: false, skipped: 'bad-input' };
  }

  let config: Record<string, unknown> = {};
  let apiBase = 'https://api.github.com';
  let token: string;
  if (forge === 'gitlab') {
    const userId = String(input.requestedBy ?? '').trim();
    const orgId = String(input.orgId ?? '').trim();
    const authorization = userId && orgId ? await deps.getGitlabAuthorization?.(userId, orgId) : null;
    token = String(authorization?.token ?? '').trim();
    if (!authorization || !token) return { ok: false, findings: 0, posted: false, skipped: 'no-account-authorization' };
    apiBase = authorization.apiBase.replace(/\/+$/, '');
    config = authorization.config ?? {};
    progress("token-resolved", "GitLab account authorization loaded");
  } else if (input.credentialSource === 'github_account') {
    const userId = String(input.requestedBy ?? '').trim();
    const authorization = userId ? await deps.getUserAuthorization?.(userId) : null;
    token = String(authorization?.token ?? '').trim();
    if (!authorization || !token) return { ok: false, findings: 0, posted: false, skipped: 'no-account-authorization' };
    apiBase = validateGithubApiBase(authorization.apiBase) ?? 'https://api.github.com';
    config = authorization.config ?? {};
    progress("token-resolved", "GitHub account authorization loaded");
  } else {
    const integ = await deps.getIntegration(String(input.installationId));
    if (!integ) return { ok: false, findings: 0, posted: false, skipped: 'no-integration' };
    const appId = String(integ.config.appId ?? '').trim();
    const privateKey = String(integ.secret.privateKey ?? '').trim();
    apiBase = validateGithubApiBase(typeof integ.config.apiBase === 'string' ? integ.config.apiBase : '') ?? 'https://api.github.com';
    if (!appId || !privateKey) return { ok: false, findings: 0, posted: false, skipped: 'no-app-creds' };
    config = integ.config;
    try {
      token = (await mintInstallationToken({ appId, privateKey, apiBase }, String(input.installationId), { fetchImpl: deps.fetchImpl as never, nowSec: deps.nowSec })).token;
    } catch (e) { const error = e instanceof Error ? e.message : 'token mint failed'; progress("error", error); return { ok: false, findings: 0, posted: false, error }; }
    progress("token-minted", "Installation token minted");
  }
  const policy = resolveReviewPolicy(config, repo);
  const gitlabProject = encodeURIComponent(repo);
  let gitlabDiffRefs: GitlabDiffRefs | undefined;

  // Resolve the head SHA if the caller didn't supply it (a `/review` comment re-run comes
  // from an issue_comment webhook, which carries no head sha). Needed for the check-run's
  // head_sha and the "Reviewed <sha>" staleness footer.
  let headSha = String(input.headSha ?? '');
  if (forge === 'gitlab') {
    try {
      const mr = await deps.fetchImpl(`${apiBase}/projects/${gitlabProject}/merge_requests/${prNumber}`, { headers: glHeaders(token) });
      if (mr.ok) {
        const payload = await mr.json() as { sha?: string; diff_refs?: GitlabDiffRefs };
        gitlabDiffRefs = payload.diff_refs;
        headSha = String(payload.diff_refs?.head_sha ?? payload.sha ?? headSha);
      }
    } catch { /* the changes endpoint below still provides a bounded failure */ }
  } else if (!headSha) {
    try {
      const pr = await deps.fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}`, { headers: ghHeaders(token) });
      if (pr.ok) { const j = (await pr.json()) as { head?: { sha?: string } }; headSha = String(j?.head?.sha ?? ''); }
    } catch { /* headSha stays '' → check-run skipped, comments still post */ }
  }
  progress("head-resolved", headSha ? "PR head resolved" : "PR head unavailable", headSha ? { sha: headSha } : undefined);

  // 1. Fetch the unified diff for the PR.
  let diff = '';
  try {
    if (forge === 'gitlab') {
      const r = await deps.fetchImpl(`${apiBase}/projects/${gitlabProject}/merge_requests/${prNumber}/changes`, { headers: glHeaders(token) });
      if (!r.ok) { const error = `diff HTTP ${r.status}`; progress("error", error); return { ok: false, findings: 0, posted: false, error }; }
      const payload = await r.json() as { changes?: Array<{ old_path?: string; new_path?: string; diff?: string }> };
      diff = (Array.isArray(payload.changes) ? payload.changes : []).map((change) => {
        const oldPath = String(change.old_path ?? change.new_path ?? 'unknown');
        const newPath = String(change.new_path ?? change.old_path ?? 'unknown');
        return `diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n${String(change.diff ?? '')}`;
      }).join('\n');
    } else {
      const result = await fetchGithubUnifiedDiff(deps.fetchImpl, apiBase, repo, prNumber, token);
      if (!result.ok) { const error = `diff HTTP ${result.status}`; progress("error", error); return { ok: false, findings: 0, posted: false, error }; }
      diff = result.diff;
    }
  } catch (e) { const error = e instanceof Error ? e.message : 'diff fetch failed'; progress("error", error); return { ok: false, findings: 0, posted: false, error }; }
  if (!diff.trim()) return { ok: true, findings: 0, posted: false, skipped: 'empty-diff' };

  // 2. Run the single-shot reviewer (this lens) over the diff.
  const cap = deps.maxDiffChars ?? 60_000;
  progress("diff-fetched", "PR diff fetched", { bytes: diff.length, truncated: diff.length > cap, files: addedLinesByPath(diff).size });
  let intelligenceContext = '';
  if ((lens.id === 'security' || lens.id === 'code') && deps.getVulnerabilityIntelligence) {
    try {
      const intelligence = await deps.getVulnerabilityIntelligence();
      if (intelligence) {
        intelligenceContext = formatVulnerabilityIntelligenceContext(intelligence, diff.slice(0, cap), { lensId: lens.id });
        progress('intelligence-ready', 'Current vulnerability intelligence loaded', {
          source: intelligence.provenance.sourceId,
          fetchedAt: intelligence.provenance.fetchedAt,
          cacheState: intelligence.cacheState,
          entries: intelligence.entries.length,
        });
      } else {
        progress('intelligence-unavailable', 'No verified vulnerability intelligence cache is available');
      }
    } catch {
      progress('intelligence-unavailable', 'Vulnerability intelligence refresh failed; continuing evidence-only review');
    }
  }
  const intelligenceAppendix = intelligenceContext ? `${intelligenceContext}\n\n` : '';
  const prompt = `You are reviewing pull request #${prNumber} in ${repo}. Here is the unified diff:\n\n\`\`\`diff\n${diff.slice(0, cap)}\n\`\`\`\n\n${intelligenceAppendix}${lens.buildContract()}`;
  let reviewText = '';
  const startedAt = Date.now();
  progress("llm-started", "Review model started", { provider: "review", model: "configured" });
  try {
    reviewText = await deps.llmRunner.run({ prompt, systemPrompt: lens.systemPrompt, taskId: `pr-${lens.id}-review:${repo}#${prNumber}`, timeoutMs: deps.timeoutMs ?? 120_000 });
  } catch (e) { const error = e instanceof Error ? e.message : 'review failed'; progress("error", error); return { ok: false, findings: 0, posted: false, error }; }
  progress("llm-finished", "Review model finished", { ms: Date.now() - startedAt });
  const findings = parseReviewFindings(stripReasoning(reviewText));
  const blocking = findings.filter((f) => lens.isBlocking(f)).length;
  progress("findings-parsed", "Findings parsed", { total: findings.length, blocking });

  // 3. Post inline review comments (with GitHub ```suggestion blocks) anchored to the
  //    diff, grouped as ONE PR review — deduped against inline comments we already
  //    posted for THIS lens so a re-run only surfaces NEW findings (Strix-style).
  const added = addedLinesByPath(diff);
  const alreadyPosted = forge === 'gitlab'
    ? await listGitlabInlineMarkers(deps.fetchImpl, apiBase, gitlabProject, prNumber, token, lens)
    : await listOurInlineMarkers(deps.fetchImpl, apiBase, repo, prNumber, token, lens);
  const inline: InlineReviewComment[] = [];
  for (const f of findings) {
    const anchor = resolveInlineAnchor(f, added);
    if (!anchor) continue; // no valid diff anchor → summary-only
    if (alreadyPosted.has(inlineFindingMarker(lens, f))) continue; // already surfaced on a prior run
    inline.push({
      path: anchor.path,
      line: anchor.line,
      side: 'RIGHT',
      ...(anchor.startLine ? { start_line: anchor.startLine, start_side: 'RIGHT' as const } : {}),
      body: formatInlineFinding(lens, f, { suggestable: anchor.suggestable }),
    });
  }
  let reviewPosted = false;
  let inlinePosted = 0;
  if (inline.length > 0) {
    if (forge === 'gitlab') {
      for (const comment of inline) {
        if (await postGitlabInlineDiscussion(deps.fetchImpl, apiBase, gitlabProject, prNumber, comment, gitlabDiffRefs, token)) inlinePosted++;
      }
      reviewPosted = inlinePosted > 0;
    } else {
      reviewPosted = await postGroupedReview(deps.fetchImpl, apiBase, repo, prNumber, headSha, buildReviewIntro(lens, inline.length), inline, token);
      if (reviewPosted) {
        inlinePosted = inline.length;
      } else {
        // A single bad anchor 422s the whole grouped review — fall back to posting each
        // inline comment on its own so one dud can't sink the rest.
        for (const c of inline) if (await postSingleInlineComment(deps.fetchImpl, apiBase, repo, prNumber, headSha, c, token)) inlinePosted++;
      }
    }
  }
  progress("inline-posted", "Inline comments posted", { n: inlinePosted, skippedAnchors: findings.length - inline.length });

  // 4. Post/update ONE idempotent PINNED SUMMARY comment (keyed by the lens marker) with
  //    the full tally — the single place to read this lens's status for the whole PR.
  const body = formatReviewSummaryComment(lens, { findings, headSha });
  const posted = forge === 'gitlab'
    ? await upsertGitlabReviewNote(deps.fetchImpl, apiBase, gitlabProject, prNumber, body, token, lens.summaryMarker)
    : await upsertReviewComment(deps.fetchImpl, apiBase, repo, prNumber, body, token, lens.summaryMarker);
  progress("summary-posted", posted ? "Review summary posted" : "Review summary could not be posted");

  // 4b. Approve the PR from this lens when it's clean AND the repo opts in (Strix
  //     "Approve clean PRs"). Approvals only on a green lens; noise otherwise.
  let approved = false;
  if (findings.length === 0 && policy.approveClean) {
    approved = forge === 'gitlab'
      ? await approveGitlabMergeRequest(deps.fetchImpl, apiBase, gitlabProject, prNumber, token)
      : await postGroupedReview(deps.fetchImpl, apiBase, repo, prNumber, headSha, buildReviewIntro(lens, 0), [], token, 'APPROVE');
  }
  if (reviewPosted) progress("review-posted", "Grouped review posted");
  if (approved) progress("approved", "Clean PR approved");

  // 5. Post a gating CHECK-RUN so the PR's Checks box reflects the review and branch
  //    protection can REQUIRE it (Strix-style). Blocking findings ⇒ failure; findings
  //    with none blocking ⇒ neutral; clean ⇒ success. When the repo's `blockOnFindings`
  //    is off, the check is advisory (never 'failure'). No-op (false) without `checks: write`.
  const checkPosted = forge === 'gitlab'
    ? await postGitlabCommitStatus(deps.fetchImpl, apiBase, gitlabProject, headSha, lens, findings, blocking, policy.blockOnFindings, token)
    : await postCheckRun(deps.fetchImpl, apiBase, repo, headSha, lens, findings, blocking, policy.blockOnFindings, token);
  progress("check-posted", checkPosted ? "Check run posted" : "Check run could not be posted", { conclusion: blocking > 0 && policy.blockOnFindings && !lens.advisory ? "failure" : findings.length > 0 ? "neutral" : "success" });
  const findingsDetail = findings.slice(0, 50).map((finding) => ({
    file: finding.file, ...(finding.line ? { line: finding.line } : {}), severity: finding.severity, title: finding.summary,
    ...(finding.summary.match(/\b(CWE-\d+)\b/i)?.[1] ? { cwe: finding.summary.match(/\b(CWE-\d+)\b/i)?.[1] } : {}),
    ...(finding.preExisting ? { preExisting: true } : {}), ...(finding.replacement ? { suggestable: true } : {}),
  }));
  progress("done", "Review completed");

  return { ok: true, findings: findings.length, blocking, posted, inlinePosted, reviewPosted, checkPosted, approved, findingsDetail };
}

interface InlineReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

async function listGitlabInlineMarkers(
  fetchImpl: typeof fetch, apiBase: string, project: string, mrNumber: number, token: string, lens: ReviewLens,
): Promise<Set<string>> {
  const markers = new Set<string>();
  try {
    const response = await fetchImpl(`${apiBase}/projects/${project}/merge_requests/${mrNumber}/discussions?per_page=100`, { headers: glHeaders(token) });
    if (!response.ok) return markers;
    const rows = await response.json() as Array<{ notes?: Array<{ body?: string }> }>;
    for (const discussion of Array.isArray(rows) ? rows : []) for (const note of discussion.notes ?? []) {
      const match = typeof note.body === 'string' ? inlineMarkerRegex(lens).exec(note.body) : null;
      if (match) markers.add(match[0]);
    }
  } catch { /* best-effort dedup */ }
  return markers;
}

async function postGitlabInlineDiscussion(
  fetchImpl: typeof fetch,
  apiBase: string,
  project: string,
  mrNumber: number,
  comment: InlineReviewComment,
  refs: GitlabDiffRefs | undefined,
  token: string,
): Promise<boolean> {
  if (!refs?.base_sha || !refs.start_sha || !refs.head_sha) return false;
  try {
    const response = await fetchImpl(`${apiBase}/projects/${project}/merge_requests/${mrNumber}/discussions`, {
      method: 'POST',
      headers: { ...glHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: comment.body,
        position: {
          position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
          old_path: comment.path, new_path: comment.path, new_line: comment.line,
        },
      }),
    });
    return response.ok;
  } catch { return false; }
}

async function upsertGitlabReviewNote(
  fetchImpl: typeof fetch, apiBase: string, project: string, mrNumber: number, body: string, token: string, marker: string,
): Promise<boolean> {
  const root = `${apiBase}/projects/${project}/merge_requests/${mrNumber}/notes`;
  try {
    const list = await fetchImpl(`${root}?per_page=100`, { headers: glHeaders(token) });
    if (list.ok) {
      const rows = await list.json() as Array<{ id?: number; body?: string }>;
      const current = (Array.isArray(rows) ? rows : []).find((note) => typeof note.body === 'string' && note.body.includes(marker));
      if (current?.id) {
        const update = await fetchImpl(`${root}/${current.id}`, {
          method: 'PUT', headers: { ...glHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        });
        return update.ok;
      }
    }
    const create = await fetchImpl(root, {
      method: 'POST', headers: { ...glHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
    });
    return create.ok;
  } catch { return false; }
}

async function approveGitlabMergeRequest(
  fetchImpl: typeof fetch, apiBase: string, project: string, mrNumber: number, token: string,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${apiBase}/projects/${project}/merge_requests/${mrNumber}/approve`, {
      method: 'POST', headers: glHeaders(token),
    });
    return response.ok;
  } catch { return false; }
}

async function postGitlabCommitStatus(
  fetchImpl: typeof fetch,
  apiBase: string,
  project: string,
  headSha: string,
  lens: ReviewLens,
  findings: ParsedReviewFinding[],
  blocking: number,
  blockOnFindings: boolean,
  token: string,
): Promise<boolean> {
  if (!headSha) return false;
  const fails = blocking > 0 && blockOnFindings && !lens.advisory;
  const description = findings.length === 0
    ? 'No issues found'
    : fails ? `${blocking} blocking, ${findings.length} total` : `${findings.length} advisory finding(s)`;
  try {
    const response = await fetchImpl(`${apiBase}/projects/${project}/statuses/${encodeURIComponent(headSha)}`, {
      method: 'POST',
      headers: { ...glHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: fails ? 'failed' : 'success', name: lens.name, description: description.slice(0, 255) }),
    });
    return response.ok;
  } catch { return false; }
}

/** Inline review comments we've already posted FOR THIS LENS, by per-finding marker (dedup across runs). */
async function listOurInlineMarkers(fetchImpl: typeof fetch, apiBase: string, repo: string, prNumber: number, token: string, lens: ReviewLens): Promise<Set<string>> {
  const markers = new Set<string>();
  const re = inlineMarkerRegex(lens);
  try {
    const r = await fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}/comments?per_page=100`, { headers: ghHeaders(token) });
    if (!r.ok) return markers;
    const arr = (await r.json()) as Array<{ body?: string }>;
    for (const c of Array.isArray(arr) ? arr : []) {
      const m = typeof c.body === 'string' ? re.exec(c.body) : null;
      if (m) markers.add(m[0]);
    }
  } catch { /* best-effort dedup */ }
  return markers;
}

/** POST one grouped PR review carrying every inline comment + a top-level body. */
async function postGroupedReview(
  fetchImpl: typeof fetch, apiBase: string, repo: string, prNumber: number, commitId: string, body: string, comments: InlineReviewComment[], token: string,
  event: 'COMMENT' | 'APPROVE' = 'COMMENT',
): Promise<boolean> {
  try {
    const r = await fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(commitId ? { commit_id: commitId } : {}), event, body, comments }),
    });
    return r.ok;
  } catch { return false; }
}

/** POST one standalone inline review comment (fallback when the grouped review 422s). */
async function postSingleInlineComment(
  fetchImpl: typeof fetch, apiBase: string, repo: string, prNumber: number, commitId: string, c: InlineReviewComment, token: string,
): Promise<boolean> {
  try {
    const r = await fetchImpl(`${apiBase}/repos/${repo}/pulls/${prNumber}/comments`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: c.body, ...(commitId ? { commit_id: commitId } : {}), path: c.path, line: c.line, side: c.side, ...(c.start_line ? { start_line: c.start_line, start_side: 'RIGHT' } : {}) }),
    });
    return r.ok;
  } catch { return false; }
}

/** Find our previous SUMMARY comment (by the lens marker) and PATCH it; else POST a new one. */
async function upsertReviewComment(fetchImpl: typeof fetch, apiBase: string, repo: string, prNumber: number, body: string, token: string, marker: string): Promise<boolean> {
  try {
    const list = await fetchImpl(`${apiBase}/repos/${repo}/issues/${prNumber}/comments?per_page=100`, { headers: ghHeaders(token) });
    if (list.ok) {
      const arr = (await list.json()) as Array<{ id?: number; body?: string }>;
      const mine = (Array.isArray(arr) ? arr : []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
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

/**
 * POST a gating check-run for this lens so the PR's Checks box reflects the review and
 * branch protection can require it. Conclusion: blocking ⇒ failure, findings-but-none-
 * blocking ⇒ neutral, clean ⇒ success. Returns false (graceful) until the App has
 * `checks: write`.
 */
async function postCheckRun(
  fetchImpl: typeof fetch, apiBase: string, repo: string, headSha: string, lens: ReviewLens, findings: ParsedReviewFinding[], blocking: number, blockOnFindings: boolean, token: string,
): Promise<boolean> {
  if (!headSha) return false;
  // Advisory lenses (code review) never fail — findings are suggestions. Security gates,
  // unless the repo opts out of blocking (then a blocking finding is neutral/advisory).
  const gates = blockOnFindings && !lens.advisory;
  const conclusion = (blocking > 0 && gates) ? 'failure' : findings.length > 0 ? 'neutral' : 'success';
  const title = lens.advisory
    ? (findings.length > 0 ? `${findings.length} suggestion(s)` : 'No suggestions')
    : blocking > 0 ? `${blocking} blocking · ${findings.length} finding(s)${blockOnFindings ? '' : ' (advisory)'}`
      : findings.length > 0 ? `${findings.length} finding(s), none blocking`
        : 'No issues found';
  const bySev = findings.reduce<Record<string, number>>((a, f) => { a[f.severity] = (a[f.severity] ?? 0) + 1; return a; }, {});
  const tally = Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(' · ') || '0';
  const summary =
    findings.length === 0
      ? lens.noFindingsLine
      : `**${blocking} blocking** · ${tally}\n\nSee the pinned **${lens.name}** summary comment and the inline suggestions on this PR.`;
  try {
    const r = await fetchImpl(`${apiBase}/repos/${repo}/check-runs`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: lens.name, head_sha: headSha, status: 'completed', conclusion, output: { title, summary } }),
    });
    return r.ok;
  } catch { return false; }
}
