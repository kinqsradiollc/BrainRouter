/**
 * MC-B6 — suggested-tasks scanner: read the connected GitHub repo for
 * actionable work and surface it as one-click starters (CLI `brainrouter
 * tasks suggest` and the desktop Tasks panel). Four signals, all via plain REST reads:
 *
 *  1. open PRs whose head commit has failing check runs,
 *  2. open PRs GitHub reports as unmergeable (merge conflicts),
 *  3. open PRs with review threads still awaiting the author (best-effort:
 *     thread resolution state is not exposed over REST, so a thread whose
 *     last word is NOT the PR author's counts as "waiting on the author"),
 *  4. open issues labeled for the mention handle (`cli.triggers
 *     .mentionHandle`) or `good first issue`.
 *
 * Each suggestion carries a `suggestedPrompt` — a self-contained, ready-to-
 * run instruction the user can paste into a chat/run session unchanged.
 *
 * Posture (additive, read-only, fail-soft):
 *  - GET-only. The scanner never posts, labels, or comments — it produces
 *    suggestions for a human to pick, nothing more.
 *  - Credentials come from the SAME resolution chain Track sync and the
 *    trigger post-back use (workspace connector → track knobs → env token);
 *    no credential is a clear, immediate error — never an anonymous call.
 *  - Every sub-request failure degrades to a warning; the scan returns what
 *    it could see. Only "no repo/token" is a hard error.
 *  - Issue/PR titles are untrusted remote text: they are whitespace-collapsed
 *    and length-capped before they land in a prompt.
 */
import { resolveGithubConfigForWorkspace } from '../track/githubSync/config.js';
import { ghHeaders } from '../track/githubSync/client.js';
import type { FetchLike } from '../track/githubSync/types.js';
import { DEFAULT_MENTION_HANDLE } from './resolvers/github.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type SuggestedTaskKind =
  | 'failing-checks'
  | 'merge-conflict'
  | 'unresolved-reviews'
  | 'labeled-issue';

export interface SuggestedTask {
  kind: SuggestedTaskKind;
  /** One human-readable line describing the finding. */
  title: string;
  /** `owner/name` repo slug the finding lives in. */
  repo: string;
  /** Issue/PR number. */
  number: number;
  /** Web URL of the issue/PR ('' when the payload carried none). */
  url: string;
  /** Ready-to-run instruction — paste into a session unchanged. */
  suggestedPrompt: string;
}

export interface SuggestedTasksResult {
  /** Repo that was scanned ('' when resolution failed). */
  repo: string;
  /** Suggestions in severity order: checks → conflicts → reviews → issues. */
  tasks: SuggestedTask[];
  /** Hard failure (no repo / no credential); `tasks` is empty then. */
  error?: string;
  /** Sub-request failures the scan tolerated (partial results). */
  warnings: string[];
}

export interface ScanSuggestedTasksOptions {
  /** Fetch implementation (tests inject a fixture-backed fake). */
  fetchImpl?: FetchLike;
  /** Explicit `owner/name` repo (default: the workspace's linked repo). */
  repo?: string;
  /** Explicit token (default: the workspace's resolved credential). */
  token?: string;
  /** API root override for GitHub Enterprise (default api.github.com). */
  apiBase?: string;
  /** Issue label the team uses to route work here (default the resolver's
   *  mention handle, `cli.triggers.mentionHandle`). */
  mentionHandle?: string;
  /** How many open PRs to inspect in depth (default 10, clamped 1..30 —
   *  each inspected PR costs three extra GET calls). */
  maxPrs?: number;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const TITLE_MAX_CHARS = 160;

/** Collapse whitespace + cap length: remote titles are untrusted text that
 *  ends up inside a prompt, so they never carry newlines or unbounded size. */
export function sanitizeSuggestionTitle(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function posInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// REST payload subsets (structural — extra fields are ignored)
// ---------------------------------------------------------------------------

interface PullSummary {
  number: number;
  title: string;
  url: string;
  headSha: string;
  author: string;
}

interface ReviewCommentShape {
  id?: unknown;
  in_reply_to_id?: unknown;
  user?: { login?: unknown };
}

function parsePullList(payload: unknown): PullSummary[] {
  if (!Array.isArray(payload)) return [];
  const pulls: PullSummary[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const number = posInt(raw.number);
    if (number === undefined) continue;
    const head = raw.head && typeof raw.head === 'object' ? (raw.head as Record<string, unknown>) : {};
    const user = raw.user && typeof raw.user === 'object' ? (raw.user as Record<string, unknown>) : {};
    pulls.push({
      number,
      title: sanitizeSuggestionTitle(raw.title),
      url: str(raw.html_url),
      headSha: str(head.sha),
      author: str(user.login),
    });
  }
  return pulls;
}

/** Names of failed runs from a `check-runs` listing (deduped, capped). */
export function extractFailingCheckNames(payload: unknown, cap = 5): string[] {
  const body = (payload && typeof payload === 'object' ? payload : {}) as { check_runs?: unknown };
  const runs = Array.isArray(body.check_runs) ? body.check_runs : [];
  const failing = new Set<string>();
  for (const run of runs) {
    if (!run || typeof run !== 'object') continue;
    const raw = run as Record<string, unknown>;
    const conclusion = str(raw.conclusion).toLowerCase();
    if (conclusion !== 'failure' && conclusion !== 'timed_out') continue;
    failing.add(sanitizeSuggestionTitle(raw.name) || 'unnamed check');
    if (failing.size >= cap) break;
  }
  return [...failing];
}

/** True when a PR detail payload reports a merge conflict. GitHub's
 *  `mergeable` is a tri-state (true/false/null-while-computing) — only an
 *  explicit false (or `mergeable_state: 'dirty'`) counts; unknown stays
 *  silent rather than nagging about PRs that merge fine. */
export function pullHasMergeConflict(payload: unknown): boolean {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (body.mergeable === false) return true;
  return str(body.mergeable_state).toLowerCase() === 'dirty';
}

/**
 * Count review threads whose LAST comment is not the PR author's — the
 * closest REST-only approximation of "unresolved": the reviewer spoke last
 * and the author still owes a response. (Thread resolution flags exist only
 * in the GraphQL API; this stays deliberately cheap.)
 */
export function countThreadsAwaitingAuthor(payload: unknown, prAuthor: string): number {
  if (!Array.isArray(payload)) return 0;
  // Comments arrive oldest-first; the last writer per thread root wins.
  const lastAuthorByThread = new Map<number, string>();
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as ReviewCommentShape;
    const id = posInt(raw.id);
    if (id === undefined) continue;
    const root = posInt(raw.in_reply_to_id) ?? id;
    const login = str(raw.user && typeof raw.user === 'object' ? raw.user.login : '');
    lastAuthorByThread.set(root, login);
  }
  let waiting = 0;
  for (const lastAuthor of lastAuthorByThread.values()) {
    if (!prAuthor || lastAuthor.toLowerCase() !== prAuthor.toLowerCase()) waiting += 1;
  }
  return waiting;
}

// ---------------------------------------------------------------------------
// Prompt rendering (pure)
// ---------------------------------------------------------------------------

function quoteTitle(title: string): string {
  return title ? ` ("${title}")` : '';
}

export function formatSuggestedPrompt(
  kind: SuggestedTaskKind,
  repo: string,
  number: number,
  title: string,
  detail: string,
): string {
  switch (kind) {
    case 'failing-checks':
      return `Fix the failing checks on PR #${number} in ${repo}${quoteTitle(title)}: ${detail}. Check out the PR branch, reproduce each failure locally, fix it, and push the fixes to the same branch.`;
    case 'merge-conflict':
      return `Resolve the merge conflicts on PR #${number} in ${repo}${quoteTitle(title)}. Check out the PR branch, update it against its base branch, resolve the conflicts, and push.`;
    case 'unresolved-reviews':
      return `Address the ${detail} open review thread(s) on PR #${number} in ${repo}${quoteTitle(title)}. Read each reviewer comment, apply or answer it, and push the requested changes.`;
    default: // labeled-issue
      return `Work on issue #${number} in ${repo}${quoteTitle(title)}. Implement it on a fresh branch and open a pull request that references the issue.`;
  }
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PRS = 10;
const GOOD_FIRST_ISSUE_LABEL = 'good first issue';

/**
 * Scan the workspace's connected GitHub repo for actionable work. Read-only;
 * fail-soft per signal; a missing repo/credential is the only hard error.
 */
export async function scanSuggestedTasks(
  workspaceRoot: string,
  options: ScanSuggestedTasksOptions = {},
): Promise<SuggestedTasksResult> {
  const warnings: string[] = [];

  // Credential resolution — explicit args win, else the workspace chain.
  let repo = str(options.repo);
  let token = str(options.token);
  if (!repo || !token) {
    const resolved = resolveGithubConfigForWorkspace(workspaceRoot, repo || undefined, token || undefined);
    if (resolved.error) return { repo: '', tasks: [], error: resolved.error, warnings };
    repo = repo || str(resolved.repo);
    token = token || str(resolved.token);
  }
  if (!repo) {
    return {
      repo: '',
      tasks: [],
      error: 'No GitHub repo is linked to this workspace. Connect one in Settings → Connectors → GitHub (or pass --repo owner/name).',
      warnings,
    };
  }
  if (!token) {
    return {
      repo,
      tasks: [],
      error: `No GitHub credential found for ${repo}. Add a token to the GitHub connector (or set GITHUB_TOKEN).`,
      warnings,
    };
  }

  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const apiBase = str(options.apiBase) || 'https://api.github.com';
  const root = `${apiBase}/repos/${repo}`;
  const maxPrs = Math.min(30, Math.max(1, options.maxPrs ?? DEFAULT_MAX_PRS));
  const handleLabel = str(options.mentionHandle).replace(/^@/, '') || DEFAULT_MENTION_HANDLE;

  /** One tolerated GET: undefined (plus a warning) on any failure. */
  const getJson = async (url: string, what: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: ghHeaders(token) });
      if (!res.ok) {
        warnings.push(`${what}: HTTP ${res.status}`);
        return undefined;
      }
      return await res.json();
    } catch (error) {
      warnings.push(`${what}: ${(error as Error).message}`);
      return undefined;
    }
  };

  const failingChecks: SuggestedTask[] = [];
  const conflicts: SuggestedTask[] = [];
  const reviews: SuggestedTask[] = [];
  const issues: SuggestedTask[] = [];

  // ---- Signals 1–3: open PRs -------------------------------------------
  const pullsPayload = await getJson(`${root}/pulls?state=open&per_page=${maxPrs}`, 'open PRs');
  for (const pull of parsePullList(pullsPayload).slice(0, maxPrs)) {
    // (1) failing check runs on the head commit.
    if (pull.headSha) {
      const checksPayload = await getJson(
        `${root}/commits/${pull.headSha}/check-runs?per_page=100`,
        `PR #${pull.number} check runs`,
      );
      const failed = checksPayload === undefined ? [] : extractFailingCheckNames(checksPayload);
      if (failed.length > 0) {
        failingChecks.push({
          kind: 'failing-checks',
          title: `PR #${pull.number}${quoteTitle(pull.title)} has failing checks: ${failed.join(', ')}`,
          repo,
          number: pull.number,
          url: pull.url,
          suggestedPrompt: formatSuggestedPrompt('failing-checks', repo, pull.number, pull.title, failed.join(', ')),
        });
      }
    }

    // (2) merge conflicts — the list payload omits mergeability, so one
    // detail read per PR.
    const detailPayload = await getJson(`${root}/pulls/${pull.number}`, `PR #${pull.number} detail`);
    if (detailPayload !== undefined && pullHasMergeConflict(detailPayload)) {
      conflicts.push({
        kind: 'merge-conflict',
        title: `PR #${pull.number}${quoteTitle(pull.title)} has merge conflicts`,
        repo,
        number: pull.number,
        url: pull.url,
        suggestedPrompt: formatSuggestedPrompt('merge-conflict', repo, pull.number, pull.title, ''),
      });
    }

    // (3) review threads awaiting the author (REST approximation).
    const commentsPayload = await getJson(
      `${root}/pulls/${pull.number}/comments?per_page=100`,
      `PR #${pull.number} review comments`,
    );
    const waiting = commentsPayload === undefined ? 0 : countThreadsAwaitingAuthor(commentsPayload, pull.author);
    if (waiting > 0) {
      reviews.push({
        kind: 'unresolved-reviews',
        title: `PR #${pull.number}${quoteTitle(pull.title)} has ${waiting} review thread(s) awaiting a response`,
        repo,
        number: pull.number,
        url: pull.url,
        suggestedPrompt: formatSuggestedPrompt('unresolved-reviews', repo, pull.number, pull.title, String(waiting)),
      });
    }
  }

  // ---- Signal 4: labeled open issues -------------------------------------
  const seenIssues = new Set<number>();
  for (const label of [handleLabel, GOOD_FIRST_ISSUE_LABEL]) {
    const payload = await getJson(
      `${root}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=20`,
      `issues labeled "${label}"`,
    );
    if (!Array.isArray(payload)) continue;
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as Record<string, unknown>;
      // The issues endpoint also returns PRs — those are covered above.
      if (raw.pull_request) continue;
      const number = posInt(raw.number);
      if (number === undefined || seenIssues.has(number)) continue;
      seenIssues.add(number);
      const title = sanitizeSuggestionTitle(raw.title);
      issues.push({
        kind: 'labeled-issue',
        title: `Issue #${number}${quoteTitle(title)} is labeled "${label}"`,
        repo,
        number,
        url: str(raw.html_url),
        suggestedPrompt: formatSuggestedPrompt('labeled-issue', repo, number, title, ''),
      });
    }
  }

  return { repo, tasks: [...failingChecks, ...conflicts, ...reviews, ...issues], warnings };
}
