/**
 * MC-B2 — post-back: report a trigger-spawned job's lifecycle to the GitHub
 * conversation that started it (issue / PR / review thread) as a comment.
 *
 * Three small, independently testable pieces:
 *  - `formatTriggerPostback` — pure outcome → comment-markdown formatter
 *    (queued / started / PR opened / done-without-PR / failed).
 *  - `postGithubIssueComment` — one REST call over the injected fetch,
 *    reusing the Track sync client's auth headers. Issues, PRs and inline
 *    review threads all accept comments on the `issues/{n}/comments`
 *    endpoint, so one call shape covers every trigger origin.
 *  - `watchTriggerJob` — the fleet store has no status-transition hooks, so
 *    completion post-backs poll the durable queue until the job goes
 *    terminal (interval + deadline injectable; tests never sleep for real).
 *
 * Nothing here throws for delivery problems: a failed comment must never
 * take down the ingress or the queue — the job itself is the deliverable,
 * the comment is a courtesy.
 */
import { getFleetJob, type FleetJobRecord } from '../fleet/fleetStore.js';
import { ghHeaders } from '../track/githubSync/client.js';
import type { FetchLike } from '../track/githubSync/types.js';

/** Lifecycle phases a trigger job reports back to the originating thread. */
export type TriggerJobPhase = 'queued' | 'started' | 'pr-opened' | 'done' | 'failed';

export interface TriggerJobOutcome {
  phase: TriggerJobPhase;
  jobId?: string;
  /** Set when the job delivered a PR (`phase: 'pr-opened'`). */
  prUrl?: string;
  /** Short failure/skip note ('failed' and PR-less 'done' phases). */
  error?: string;
}

/** Map a fleet job record onto the post-back phase vocabulary. */
export function fleetJobOutcome(job: FleetJobRecord): TriggerJobOutcome {
  const output = (job.output ?? {}) as { prUrl?: unknown; skipped?: unknown };
  const prUrl = typeof output.prUrl === 'string' && output.prUrl.trim() ? output.prUrl.trim() : undefined;
  const skipped = typeof output.skipped === 'string' && output.skipped.trim() ? output.skipped.trim() : undefined;
  switch (job.status) {
    case 'pending':
      return { phase: 'queued', jobId: job.id };
    case 'running':
      return { phase: 'started', jobId: job.id };
    case 'done':
      return prUrl
        ? { phase: 'pr-opened', jobId: job.id, prUrl }
        : { phase: 'done', jobId: job.id, error: skipped };
    default: // failed / cancelled
      return { phase: 'failed', jobId: job.id, error: job.error };
  }
}

/**
 * Render one outcome as the GitHub comment body. Pure and deliberately
 * plain — the comment carries a status, a job id for traceability, and (on
 * success) the PR link. Never any payload/config content, so nothing here
 * can leak a secret into a public thread.
 */
export function formatTriggerPostback(outcome: TriggerJobOutcome): string {
  const ref = outcome.jobId ? `\n\n<sub>job \`${outcome.jobId}\`</sub>` : '';
  switch (outcome.phase) {
    case 'queued':
      return `🧠 queued — I will open a PR with the result.${ref}`;
    case 'started':
      return `🧠 working on it — a PR will follow when the job finishes.${ref}`;
    case 'pr-opened':
      return `🧠 done — opened ${outcome.prUrl}.${ref}`;
    case 'done':
      return `🧠 finished without a PR${outcome.error ? ` (${outcome.error})` : ''} — there was nothing to deliver.${ref}`;
    default:
      return `🧠 the job failed${outcome.error ? `: ${outcome.error}` : ''}. It stays in the queue history for inspection.${ref}`;
  }
}

// ---------------------------------------------------------------------------
// The single REST call
// ---------------------------------------------------------------------------

export interface GithubCommentTarget {
  /** `owner/name` repo slug. */
  repo: string;
  /** Issue or PR number the comment lands on. */
  number: number;
}

export interface GithubCommentClient {
  fetchImpl: FetchLike;
  token: string;
  /** Override for GitHub Enterprise (default `https://api.github.com`). */
  apiBase?: string;
}

/**
 * Post one comment. Returns false (never throws) on any failure — missing
 * token, bad target, HTTP error, network error.
 */
export async function postGithubIssueComment(
  client: GithubCommentClient,
  target: GithubCommentTarget,
  body: string,
): Promise<boolean> {
  const repo = target.repo.trim();
  if (!client.token || !repo || !Number.isInteger(target.number) || target.number <= 0 || !body.trim()) {
    return false;
  }
  const url = `${client.apiBase ?? 'https://api.github.com'}/repos/${repo}/issues/${target.number}/comments`;
  try {
    const res = await client.fetchImpl(url, {
      method: 'POST',
      headers: ghHeaders(client.token),
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Completion watcher (poll — the queue has no transition hooks)
// ---------------------------------------------------------------------------

export interface WatchTriggerJobOptions {
  /** Job reader (default: the durable fleet store). Tests inject a fake. */
  getJob?: (id: string) => FleetJobRecord | undefined;
  /** Poll interval (default 15s). */
  intervalMs?: number;
  /** Give-up deadline (default 2h) — a watcher must never hang forever. */
  timeoutMs?: number;
  /** Sleep impl (tests inject an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

const WATCH_DEFAULT_INTERVAL_MS = 15_000;
const WATCH_DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Poll the fleet queue until `jobId` reaches a terminal status, then return
 * its outcome. Null when the job disappears or the deadline passes — the
 * caller simply posts no completion comment in that case.
 */
export async function watchTriggerJob(
  jobId: string,
  options: WatchTriggerJobOptions = {},
): Promise<TriggerJobOutcome | null> {
  const getJob = options.getJob ?? ((id: string) => getFleetJob(id));
  const intervalMs = Math.max(1, options.intervalMs ?? WATCH_DEFAULT_INTERVAL_MS);
  const timeoutMs = Math.max(1, options.timeoutMs ?? WATCH_DEFAULT_TIMEOUT_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(jobId);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      return fleetJobOutcome(job);
    }
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}
