/**
 * MC-B4 — proactive CI-failure nudge: when a `workflow_run.completed` event
 * reports `conclusion: failure` for an OPEN pull request in an allowlisted
 * repo, post one short comment on the PR offering the fix. The comment tells
 * the human to reply `@<handle> fix the failing checks` — that reply is an
 * ordinary @mention comment, so it flows straight back through the existing
 * MC-B2 mention resolver and becomes a queued fleet job. The nudge itself
 * never enqueues anything; it only closes the loop between CI and the
 * mention path.
 *
 * Posture (additive, default-inert, defensive):
 *  - Gated behind `cli.triggers.ciNudge` (default false) — no nudge is ever
 *    posted unless the user opts in explicitly.
 *  - Idempotent PER HEAD-SHA: the dedupe key is `repo + head sha + workflow`,
 *    persisted in the SAME delivery cache MC-B2 uses. A re-run of the same
 *    failing workflow on the same commit (a fresh delivery id every time)
 *    still nudges at most once.
 *  - Runs that are not tied to an open PR are ignored — pushes to branches
 *    without a PR, and runs whose PR references are closed, get nothing.
 *  - The comment goes through the MC-B2 post-back client; a failed post is
 *    NOT remembered, so a webhook redelivery may retry the courtesy comment.
 *  - Never throws for delivery-shaped problems; malformed payloads skip.
 */
import { readTriggerPayload } from './rules.js';
import {
  DEFAULT_MENTION_HANDLE,
  hasSeenTriggerDelivery,
  markTriggerDeliverySeen,
} from './resolvers/github.js';
import type { GithubCommentTarget } from './postback.js';
import type { TriggerEvent } from './triggerTypes.js';

// ---------------------------------------------------------------------------
// Payload extraction (pure)
// ---------------------------------------------------------------------------

interface WorkflowRunPayloadShape {
  workflow_run?: {
    name?: unknown;
    head_sha?: unknown;
    conclusion?: unknown;
    pull_requests?: Array<{ number?: unknown; state?: unknown }>;
  };
}

export interface WorkflowRunContext {
  /** Workflow display name ('' when the payload carries none). */
  workflow: string;
  /** Head commit sha the run executed against ('' when absent). */
  headSha: string;
  /** Run conclusion (`failure`, `success`, `cancelled`, ...; '' when absent). */
  conclusion: string;
  /** Number of the first OPEN pull request the run is associated with.
   *  Undefined when the run has no PR, or only closed-PR references —
   *  either way the nudge stays silent. */
  prNumber: number | undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Pull the nudge-relevant details out of a (redacted) workflow_run payload. */
export function extractWorkflowRunContext(payload: unknown): WorkflowRunContext {
  const body = (payload && typeof payload === 'object' ? payload : {}) as WorkflowRunPayloadShape;
  const run = body.workflow_run && typeof body.workflow_run === 'object' ? body.workflow_run : {};
  const refs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  let prNumber: number | undefined;
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const number = typeof ref.number === 'number' && Number.isInteger(ref.number) && ref.number > 0
      ? ref.number
      : undefined;
    if (number === undefined) continue;
    // The webhook's PR references usually omit `state`; when it IS present,
    // anything but 'open' is a closed/merged PR and must not be nudged.
    const state = str(ref.state).toLowerCase();
    if (state && state !== 'open') continue;
    prNumber = number;
    break;
  }
  return {
    workflow: str(run.name),
    headSha: str(run.head_sha),
    conclusion: str(run.conclusion).toLowerCase(),
    prNumber,
  };
}

// ---------------------------------------------------------------------------
// Idempotency key + comment body (pure)
// ---------------------------------------------------------------------------

/** One nudge per repo + head sha + workflow, stored in the delivery cache. */
export function ciNudgeCacheKey(repo: string, headSha: string, workflow: string): string {
  return `ci-nudge:${repo}@${headSha}:${workflow}`;
}

/** The offer-to-fix comment. Plain text + the mention that loops back into
 *  the MC-B2 resolver; never any payload/log content, so nothing here can
 *  leak into a public thread. */
export function formatCiNudgeComment(workflow: string, mentionHandle: string): string {
  const handle = mentionHandle.trim().replace(/^@/, '') || DEFAULT_MENTION_HANDLE;
  const name = workflow.trim() || 'CI';
  return `CI failed on ${name}. Comment \`@${handle} fix the failing checks\` and I will take a look.`;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface CiNudgeOptions {
  /** Workspace whose delivery cache serves this event. */
  workspaceRoot: string;
  /** `cli.triggers.ciNudge` — the nudge never fires unless explicitly true. */
  enabled?: boolean;
  /** @mention handle quoted in the nudge (default `DEFAULT_MENTION_HANDLE`). */
  mentionHandle?: string;
  /** Payload reader (default: re-read the event's `payloadRef` file). */
  readPayload?: (event: TriggerEvent) => unknown;
  /** Comment port (the MC-B2 post-back client in production; tests fake). */
  postComment?: (target: GithubCommentTarget, body: string) => Promise<boolean> | boolean;
}

export interface CiNudgeResult {
  action: 'nudged' | 'deduped' | 'skipped';
  /** Why nothing was posted ('skipped'/'deduped' actions). */
  reason?: string;
  /** The dedupe key used, when the event got far enough to have one. */
  cacheKey?: string;
}

function skip(reason: string): CiNudgeResult {
  return { action: 'skipped', reason };
}

/**
 * Resolve one verified + allowlisted event into at most one CI-failure nudge
 * comment. Silent on every non-matching shape; never throws for delivery
 * problems — the nudge is a courtesy, not a deliverable.
 */
export async function resolveCiNudge(
  event: TriggerEvent,
  options: CiNudgeOptions,
): Promise<CiNudgeResult> {
  if (options.enabled !== true) return skip('disabled');
  if (event.provider !== 'github') return skip('not-github');
  if (event.kind !== 'workflow_run.completed') return skip('not-workflow-run-completed');
  const repo = event.repo.trim();
  if (!repo) return skip('no-repo');

  const payload = options.readPayload ? options.readPayload(event) : readTriggerPayload(event);
  const context = extractWorkflowRunContext(payload);
  if (context.conclusion !== 'failure') return skip('not-a-failure');
  if (context.prNumber === undefined) return skip('no-open-pr');
  // Without a head sha the nudge cannot be idempotent — stay silent rather
  // than risk a comment per re-run (fail-closed).
  if (!context.headSha) return skip('no-head-sha');

  const cacheKey = ciNudgeCacheKey(repo, context.headSha, context.workflow);
  if (hasSeenTriggerDelivery(options.workspaceRoot, cacheKey)) {
    return { action: 'deduped', reason: 'already-nudged', cacheKey };
  }

  if (!options.postComment) return { ...skip('no-comment-port'), cacheKey };
  let posted = false;
  try {
    posted = await options.postComment(
      { repo, number: context.prNumber },
      formatCiNudgeComment(context.workflow, options.mentionHandle ?? DEFAULT_MENTION_HANDLE),
    );
  } catch {
    posted = false;
  }
  if (!posted) {
    // Not remembered: a redelivery may retry the courtesy comment later.
    return { ...skip('post-failed'), cacheKey };
  }
  markTriggerDeliverySeen(options.workspaceRoot, cacheKey);
  return { action: 'nudged', cacheKey };
}
