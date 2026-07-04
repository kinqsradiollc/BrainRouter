/**
 * MC-B2 — the GitHub resolver: verified trigger events → durable fleet jobs
 * → PR delivery → comment back. This is the flagship reflex: a label or an
 * @mention in the tools a team already uses becomes a queued, isolated agent
 * job whose result arrives as a reviewable draft PR.
 *
 * Two firing paths, both additive and default-inert:
 *  - RULES (MC-B3): any enabled `.brainrouter/automations/*.md` rule whose
 *    `on`/`when` matches the event fires (e.g. `on: github.issue.labeled`,
 *    `when: label == 'brainrouter'`).
 *  - MENTION: an issue body, issue/PR comment, or inline review comment that
 *    @mentions the configured handle (`cli.triggers.mentionHandle`, default
 *    'brainrouter') fires even with no rule — the comment text IS the ask.
 *
 * The job spec is SELF-CONTAINED (repo slug, PR branch when known, the full
 * instruction text) and enqueued on the EXISTING durable fleet queue as a
 * `kind: 'build'` job with `delivery: 'pr-emit'` — the fleet drain path
 * already knows how to run a build and deliver it as a draft PR; no new
 * runner exists here. Post-backs go through `postback.ts`.
 *
 * Safety posture (this sits behind the ingress, but stays defensive):
 *  - Instruction text is re-redacted + bounded before it enters the queue —
 *    the payload file is already redacted, this keeps the property local.
 *  - Idempotency is two layers: a persisted delivery-id cache (a redelivered
 *    webhook — GitHub retries on 5xx — never enqueues twice, even after the
 *    first job finished) plus the queue's own in-flight `idempotencyKey`.
 *  - Every dependency with side effects (queue, rules, payload read, REST
 *    comment) is injectable, so tests run fully offline.
 */
import path from 'node:path';
import { enqueueFleetJob, type CreateFleetJobInput, type FleetJobRecord } from '../../fleet/fleetStore.js';
import { redactSecrets } from '../../git/prEmit.js';
import { getWorkspaceStateRoot, readJsonFile, writeJsonFile } from '../../storage/store.js';
import { resolveGithubConfigForWorkspace } from '../../track/githubSync/config.js';
import type { FetchLike } from '../../track/githubSync/types.js';
import { resolveCiNudge, type CiNudgeResult } from '../ciNudge.js';
import { formatTriggerPostback, postGithubIssueComment, type GithubCommentTarget } from '../postback.js';
import {
  buildAutomationEvent,
  loadRules,
  matchRules,
  readTriggerPayload,
  type AutomationRule,
} from '../rules.js';
import type { TriggerEvent, TriggerSink } from '../triggerTypes.js';

/** Default @mention handle (override via `cli.triggers.mentionHandle`). */
export const DEFAULT_MENTION_HANDLE = 'brainrouter';

/** Cap on the instruction text a job carries — a hostile issue body cannot
 *  bloat the durable queue file. */
export const TRIGGER_INSTRUCTION_MAX_CHARS = 16_000;

/** Most-recent delivery ids remembered for redelivery dedup. */
export const TRIGGER_DELIVERY_CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// Delivery-id cache (persisted — a redelivery may arrive after a restart)
// ---------------------------------------------------------------------------

interface DeliveryCacheFile {
  version: 1;
  seen: string[];
}

/** Where a workspace remembers processed webhook delivery ids. */
export function triggerDeliveriesFile(workspaceRoot: string): string {
  return path.join(getWorkspaceStateRoot(workspaceRoot), 'triggers', 'deliveries.json');
}

function emptyDeliveryCache(): DeliveryCacheFile {
  return { version: 1, seen: [] };
}

export function hasSeenTriggerDelivery(workspaceRoot: string, deliveryId: string): boolean {
  const id = deliveryId.trim();
  if (!id) return false;
  return readJsonFile<DeliveryCacheFile>(triggerDeliveriesFile(workspaceRoot), emptyDeliveryCache())
    .seen.includes(id);
}

/** Remember a processed delivery id (bounded FIFO — oldest ids age out). */
export function markTriggerDeliverySeen(workspaceRoot: string, deliveryId: string): void {
  const id = deliveryId.trim();
  if (!id) return;
  const file = triggerDeliveriesFile(workspaceRoot);
  const data = readJsonFile<DeliveryCacheFile>(file, emptyDeliveryCache());
  if (data.seen.includes(id)) return;
  data.seen.push(id);
  if (data.seen.length > TRIGGER_DELIVERY_CACHE_MAX) {
    data.seen = data.seen.slice(data.seen.length - TRIGGER_DELIVERY_CACHE_MAX);
  }
  writeJsonFile(file, data);
}

// ---------------------------------------------------------------------------
// Mention + payload extraction (pure)
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` @mentions `handle` as a whole word (case-insensitive). */
export function containsMention(text: string, handle: string): boolean {
  const clean = handle.trim().replace(/^@/, '');
  if (!clean || !text) return false;
  return new RegExp(`@${escapeRegExp(clean)}\\b`, 'i').test(text);
}

/** Event kinds whose text is scanned for an @mention. */
const MENTION_KINDS: ReadonlySet<string> = new Set([
  'issue.opened',
  'comment.created',
  'review.comment',
  'pull_request.opened',
]);

interface GithubTriggerContext {
  /** The human ask: comment body when the event is a comment, else the
   *  issue/PR body. '' when the payload carries none. */
  text: string;
  /** Issue/PR title, for the job title + PR slug. */
  title: string;
  /** PR head branch, when the event names a pull request. */
  prBranch: string;
  /** Comment id (fallback idempotency component for comment events). */
  commentId: number | undefined;
}

interface GithubPayloadDetails {
  issue?: { title?: unknown; body?: unknown };
  pull_request?: { title?: unknown; body?: unknown; head?: { ref?: unknown } };
  comment?: { id?: unknown; body?: unknown };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Pull the instruction-relevant details out of a (redacted) payload. */
export function extractGithubTriggerContext(kind: string, payload: unknown): GithubTriggerContext {
  const body = (payload && typeof payload === 'object' ? payload : {}) as GithubPayloadDetails;
  const commentBody = str(body.comment?.body);
  const itemBody = str(body.issue?.body) || str(body.pull_request?.body);
  const isComment = kind.startsWith('comment.') || kind === 'review.comment';
  const commentId = typeof body.comment?.id === 'number' ? body.comment.id : undefined;
  return {
    text: (isComment ? commentBody : itemBody) || commentBody || itemBody,
    title: str(body.issue?.title) || str(body.pull_request?.title),
    prBranch: str(body.pull_request?.head?.ref),
    commentId,
  };
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface GithubResolveOptions {
  /** Workspace whose rules, state root and connectors serve this event. */
  workspaceRoot: string;
  /** @mention handle (default `DEFAULT_MENTION_HANDLE`). */
  mentionHandle?: string;
  /** Fleet home override (tests). Passed through to the default enqueue. */
  home?: string;
  /** Pre-matched/loaded rules; default loads the workspace registry. */
  rules?: AutomationRule[];
  /** Payload reader (default: re-read the event's `payloadRef` file). */
  readPayload?: (event: TriggerEvent) => unknown;
  /** Queue port (default: the durable fleet store). Tests inject a fake. */
  enqueue?: (input: CreateFleetJobInput) => { job: FleetJobRecord; deduped: boolean };
  /** Comment port. Absent = no post-back (resolution still enqueues). */
  postComment?: (target: GithubCommentTarget, body: string) => Promise<boolean> | boolean;
}

export interface GithubResolveResult {
  action: 'enqueued' | 'deduped' | 'skipped';
  /** Why nothing was enqueued ('skipped'/'deduped' actions). */
  reason?: string;
  job?: FleetJobRecord;
  /** Ids of the automation rules that matched. */
  matchedRules: string[];
  /** Whether the @mention path fired. */
  mentioned: boolean;
}

function skip(reason: string): GithubResolveResult {
  return { action: 'skipped', reason, matchedRules: [], mentioned: false };
}

/** Compose the self-contained instruction text the job carries. */
function buildInstructions(
  event: TriggerEvent,
  context: GithubTriggerContext,
  matched: AutomationRule[],
): string {
  const lines: string[] = [
    `GitHub trigger: ${event.kind} on ${event.repo}${event.number ? `#${event.number}` : ''}` +
      (event.sender ? ` (by @${event.sender})` : ''),
  ];
  if (context.title) lines.push('', `# ${context.title}`);
  if (context.text.trim()) lines.push('', context.text.trim());
  const withInstructions = matched.filter((rule) => rule.instructions.trim());
  if (withInstructions.length) {
    lines.push('', '## Automation rule instructions');
    for (const rule of withInstructions) lines.push('', `### ${rule.id}`, rule.instructions.trim());
  }
  lines.push(
    '',
    '## Delivery',
    '- Implement the ask above in this repository.',
    '- Deliver the result as a reviewable draft PR; do not push to the default branch.',
  );
  return redactSecrets(lines.join('\n')).slice(0, TRIGGER_INSTRUCTION_MAX_CHARS);
}

/**
 * Resolve one verified + allowlisted GitHub trigger event: match rules, scan
 * for an @mention, and — when either fires — enqueue a self-contained fleet
 * job and post the "queued" comment back. Never throws for delivery-shaped
 * problems; a malformed event simply resolves to 'skipped'.
 */
export async function resolveGithubTrigger(
  event: TriggerEvent,
  options: GithubResolveOptions,
): Promise<GithubResolveResult> {
  if (event.provider !== 'github') return skip('not-github');
  const workspaceRoot = options.workspaceRoot;

  // Layer 1 idempotency: a redelivered webhook (same delivery GUID) is a
  // no-op even long after the original job finished.
  const deliveryId = (event.deliveryId ?? '').trim();
  if (deliveryId && hasSeenTriggerDelivery(workspaceRoot, deliveryId)) {
    return { action: 'deduped', reason: 'delivery-replay', matchedRules: [], mentioned: false };
  }

  const payload = options.readPayload ? options.readPayload(event) : readTriggerPayload(event);
  const rules = options.rules ?? loadRules(workspaceRoot);
  const matched = matchRules(rules, buildAutomationEvent(event, payload));
  const context = extractGithubTriggerContext(event.kind, payload);
  const handle = options.mentionHandle?.trim() || DEFAULT_MENTION_HANDLE;
  const mentioned = MENTION_KINDS.has(event.kind) && containsMention(context.text, handle);

  if (matched.length === 0 && !mentioned) {
    // Nothing fired — remember the delivery so a replay of this same no-op
    // doesn't re-run rule matching either.
    if (deliveryId) markTriggerDeliverySeen(workspaceRoot, deliveryId);
    return skip('no-rule-no-mention');
  }

  const matchedIds = matched.map((rule) => rule.id);
  const kindSlug = event.kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const job: CreateFleetJobInput = {
    kind: 'build',
    workspaceRoot,
    input: {
      source: 'trigger:github',
      delivery: 'pr-emit',
      repo: event.repo,
      prompt: buildInstructions(event, context, matched),
      title: `${event.repo}${event.number ? `#${event.number}` : ''}: ${context.title || event.kind}`,
      slug: `trigger-${kindSlug}${event.number ? `-${event.number}` : ''}`,
      ...(context.prBranch ? { baseBranch: context.prBranch } : {}),
      // The originating event, verbatim enough for the completion post-back.
      trigger: {
        provider: event.provider,
        kind: event.kind,
        repo: event.repo,
        number: event.number,
        sender: event.sender,
        deliveryId: deliveryId || undefined,
        receivedAt: event.receivedAt,
        rules: matchedIds,
        mentioned,
      },
    },
    // Layer 2 idempotency: the queue's own in-flight dedup key.
    idempotencyKey: deliveryId
      ? `trigger:github:${deliveryId}`
      : `trigger:github:${event.repo}#${event.number ?? 0}:${event.kind}:${context.commentId ?? ''}`,
  };

  const enqueue = options.enqueue ?? ((input: CreateFleetJobInput) => enqueueFleetJob(input, { home: options.home }));
  const result = enqueue(job);
  if (deliveryId) markTriggerDeliverySeen(workspaceRoot, deliveryId);
  if (result.deduped) {
    return { action: 'deduped', reason: 'in-flight-duplicate', job: result.job, matchedRules: matchedIds, mentioned };
  }

  // Post-back is a courtesy: failures are swallowed — the job is queued
  // either way and the completion watcher can still comment later.
  if (options.postComment && event.number) {
    try {
      await options.postComment(
        { repo: event.repo, number: event.number },
        formatTriggerPostback({ phase: 'queued', jobId: result.job.id }),
      );
    } catch {
      // Never let a comment failure undo an enqueue.
    }
  }
  return { action: 'enqueued', job: result.job, matchedRules: matchedIds, mentioned };
}

// ---------------------------------------------------------------------------
// Sink composition (what `brainrouter serve --triggers` mounts)
// ---------------------------------------------------------------------------

export interface GithubTriggerSinkOptions {
  workspaceRoot: string;
  mentionHandle?: string;
  /** MC-B4 — `cli.triggers.ciNudge`: when true, failed `workflow_run`
   *  completions for open PRs get one offer-to-fix comment. Default false. */
  ciNudge?: boolean;
  /** Comment port override; default resolves the workspace's GitHub
   *  connector credential and posts via global fetch. */
  postComment?: GithubResolveOptions['postComment'];
  /** Result observer (the serve command logs enqueues). */
  onResolved?: (event: TriggerEvent, result: GithubResolveResult) => void;
  /** MC-B4 — nudge observer (the serve command logs posted nudges). */
  onNudged?: (event: TriggerEvent, result: CiNudgeResult) => void;
}

/** Default comment port: the workspace's GitHub connector credential + fetch. */
function defaultPostComment(workspaceRoot: string): GithubResolveOptions['postComment'] {
  return async (target, body) => {
    const config = resolveGithubConfigForWorkspace(workspaceRoot, target.repo);
    if (!config.token) return false;
    return postGithubIssueComment(
      { fetchImpl: fetch as unknown as FetchLike, token: config.token },
      target,
      body,
    );
  };
}

/**
 * Build the `TriggerSink` the ingress server mounts: every verified +
 * allowlisted GitHub event flows through `resolveGithubTrigger` with the
 * real queue, the workspace rule registry, and the connector-credentialed
 * comment port. Events from other providers are ignored (skipped) here.
 */
export function createGithubTriggerSink(options: GithubTriggerSinkOptions): TriggerSink {
  return async (event: TriggerEvent) => {
    const postComment = options.postComment ?? defaultPostComment(options.workspaceRoot);
    const result = await resolveGithubTrigger(event, {
      workspaceRoot: options.workspaceRoot,
      mentionHandle: options.mentionHandle,
      postComment,
    });
    options.onResolved?.(event, result);
    // MC-B4 — the CI-failure nudge rides the same sink (own opt-in knob, own
    // per-head-sha dedupe key); its outcome never affects the resolver's.
    if (options.ciNudge === true) {
      const nudge = await resolveCiNudge(event, {
        workspaceRoot: options.workspaceRoot,
        enabled: true,
        mentionHandle: options.mentionHandle,
        postComment,
      });
      options.onNudged?.(event, nudge);
    }
  };
}
