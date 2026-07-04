import { enqueueFleetJob, type CreateFleetJobInput, type FleetJobRecord } from '../../fleet/fleetStore.js';
import { redactSecrets } from '../../git/prEmit.js';
import {
  buildAutomationEvent,
  loadRules,
  matchRules,
  readTriggerPayload,
  type AutomationRule,
} from '../rules.js';
import type { TriggerEvent, TriggerSink } from '../triggerTypes.js';
import { containsMention, DEFAULT_MENTION_HANDLE, TRIGGER_INSTRUCTION_MAX_CHARS } from './github.js';

interface ExternalTriggerContext {
  text: string;
  title: string;
  prBranch: string;
  commentId?: number;
}

export interface ExternalResolveOptions {
  workspaceRoot: string;
  providers?: readonly string[];
  mentionHandle?: string;
  home?: string;
  rules?: AutomationRule[];
  readPayload?: (event: TriggerEvent) => unknown;
  enqueue?: (input: CreateFleetJobInput) => { job: FleetJobRecord; deduped: boolean };
  onResolved?: (event: TriggerEvent, result: ExternalResolveResult) => void;
}

export interface ExternalResolveResult {
  action: 'enqueued' | 'deduped' | 'skipped';
  reason?: string;
  job?: FleetJobRecord;
  matchedRules: string[];
  mentioned: boolean;
}

const DEFAULT_PROVIDERS = new Set(['gitlab', 'jira']);
const MENTION_KINDS = new Set(['issue.opened', 'comment.created', 'review.comment', 'pull_request.opened']);

function skip(reason: string): ExternalResolveResult {
  return { action: 'skipped', reason, matchedRules: [], mentioned: false };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function extractGitlabContext(payload: unknown): ExternalTriggerContext {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const attrs = body.object_attributes ?? {};
  return {
    text: str(attrs.note) || str(attrs.description) || str(attrs.title),
    title: str(attrs.title),
    prBranch: str(attrs.source_branch),
    commentId: num(attrs.id),
  };
}

function extractJiraContext(payload: unknown): ExternalTriggerContext {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const fields = body.issue?.fields ?? {};
  return {
    text: str(body.comment?.body) || str(fields.description),
    title: str(fields.summary) || str(body.issue?.key),
    prBranch: '',
    commentId: num(body.comment?.id),
  };
}

export function extractExternalTriggerContext(event: TriggerEvent, payload: unknown): ExternalTriggerContext {
  if (event.provider === 'gitlab') return extractGitlabContext(payload);
  if (event.provider === 'jira') return extractJiraContext(payload);
  return { text: '', title: '', prBranch: '', commentId: undefined };
}

function buildInstructions(event: TriggerEvent, context: ExternalTriggerContext, matched: AutomationRule[]): string {
  const label = event.provider[0].toUpperCase() + event.provider.slice(1);
  const lines = [
    `${label} trigger: ${event.kind} on ${event.repo}${event.number ? `#${event.number}` : ''}` +
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

export async function resolveExternalTrigger(
  event: TriggerEvent,
  options: ExternalResolveOptions,
): Promise<ExternalResolveResult> {
  const providers = new Set(options.providers ?? DEFAULT_PROVIDERS);
  if (!providers.has(event.provider)) return skip('unsupported-provider');
  if (!event.repo) return skip('missing-repo');
  const payload = options.readPayload ? options.readPayload(event) : readTriggerPayload(event);
  const rules = options.rules ?? loadRules(options.workspaceRoot);
  const matched = matchRules(rules, buildAutomationEvent(event, payload));
  const context = extractExternalTriggerContext(event, payload);
  const handle = options.mentionHandle?.trim() || DEFAULT_MENTION_HANDLE;
  const mentioned = MENTION_KINDS.has(event.kind) && containsMention(context.text, handle);
  if (matched.length === 0 && !mentioned) return skip('no-rule-no-mention');

  const matchedIds = matched.map((rule) => rule.id);
  const kindSlug = event.kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const job: CreateFleetJobInput = {
    kind: 'build',
    workspaceRoot: options.workspaceRoot,
    input: {
      source: `trigger:${event.provider}`,
      delivery: 'pr-emit',
      repo: event.repo,
      prompt: buildInstructions(event, context, matched),
      title: `${event.repo}${event.number ? `#${event.number}` : ''}: ${context.title || event.kind}`,
      slug: `trigger-${event.provider}-${kindSlug}${event.number ? `-${event.number}` : ''}`,
      ...(context.prBranch ? { baseBranch: context.prBranch } : {}),
      trigger: {
        provider: event.provider,
        kind: event.kind,
        repo: event.repo,
        number: event.number,
        sender: event.sender,
        deliveryId: event.deliveryId,
        receivedAt: event.receivedAt,
        rules: matchedIds,
        mentioned,
      },
    },
    idempotencyKey: event.deliveryId
      ? `trigger:${event.provider}:${event.deliveryId}`
      : `trigger:${event.provider}:${event.repo}#${event.number ?? 0}:${event.kind}:${context.commentId ?? ''}`,
  };

  const enqueue = options.enqueue ?? ((input: CreateFleetJobInput) => enqueueFleetJob(input, { home: options.home }));
  const result = enqueue(job);
  if (result.deduped) {
    return { action: 'deduped', reason: 'in-flight-duplicate', job: result.job, matchedRules: matchedIds, mentioned };
  }
  return { action: 'enqueued', job: result.job, matchedRules: matchedIds, mentioned };
}

export function createExternalTriggerSink(options: ExternalResolveOptions): TriggerSink {
  return async (event: TriggerEvent) => {
    const result = await resolveExternalTrigger(event, options);
    options.onResolved?.(event, result);
  };
}
