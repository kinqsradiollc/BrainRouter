import { createHash } from 'node:crypto';
import path from 'node:path';
import { enqueueFleetJob, type CreateFleetJobInput, type FleetJobRecord } from '../../fleet/fleetStore.js';
import { redactSecrets } from '../../git/prEmit.js';
import { getWorkspaceStateRoot, readJsonFile, writeJsonFile } from '../../storage/store.js';
import {
  readTriggerPayload,
} from '../rules.js';
import type { TriggerEvent, TriggerSink } from '../triggerTypes.js';
import { containsMention, DEFAULT_MENTION_HANDLE, TRIGGER_INSTRUCTION_MAX_CHARS } from './github.js';

export interface SlackThreadRecord {
  key: string;
  conversationId: string;
  sessionKey: string;
  repo: string;
  teamId: string;
  channel: string;
  threadTs: string;
  updatedAt: string;
}

interface SlackThreadMapFile {
  version: 1;
  threads: SlackThreadRecord[];
}

interface SlackTriggerContext {
  text: string;
  teamId: string;
  channel: string;
  messageTs: string;
  threadTs: string;
  user: string;
}

interface SlackPayloadDetails {
  team_id?: unknown;
  event?: {
    text?: unknown;
    channel?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    user?: unknown;
  };
}

export interface SlackResolveOptions {
  workspaceRoot: string;
  mentionHandle?: string;
  home?: string;
  readPayload?: (event: TriggerEvent) => unknown;
  enqueue?: (input: CreateFleetJobInput) => { job: FleetJobRecord; deduped: boolean };
  now?: () => string;
  onResolved?: (event: TriggerEvent, result: SlackResolveResult) => void;
}

export interface SlackResolveResult {
  action: 'enqueued' | 'deduped' | 'skipped';
  reason?: string;
  job?: FleetJobRecord;
  conversationId?: string;
  continued: boolean;
}

function skip(reason: string): SlackResolveResult {
  return { action: 'skipped', reason, continued: false };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function slackThreadsFile(workspaceRoot: string): string {
  return path.join(getWorkspaceStateRoot(workspaceRoot), 'triggers', 'slackThreads.json');
}

function emptyThreads(): SlackThreadMapFile {
  return { version: 1, threads: [] };
}

export function slackThreadKey(teamId: string, channel: string, threadTs: string): string {
  return [teamId, channel, threadTs].map((part) => part.trim()).join(':');
}

export function extractSlackTriggerContext(payload: unknown): SlackTriggerContext {
  const body = (payload && typeof payload === 'object' ? payload : {}) as SlackPayloadDetails;
  const ev = body.event ?? {};
  const messageTs = str(ev.ts);
  return {
    text: str(ev.text),
    teamId: str(body.team_id),
    channel: str(ev.channel),
    messageTs,
    threadTs: str(ev.thread_ts) || messageTs,
    user: str(ev.user),
  };
}

function threadConversationId(key: string): string {
  return `slack_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

export function getSlackThreadRecord(workspaceRoot: string, key: string): SlackThreadRecord | undefined {
  return readJsonFile<SlackThreadMapFile>(slackThreadsFile(workspaceRoot), emptyThreads())
    .threads.find((record) => record.key === key);
}

export function upsertSlackThreadRecord(
  workspaceRoot: string,
  input: Omit<SlackThreadRecord, 'conversationId' | 'sessionKey' | 'updatedAt'> & {
    conversationId?: string;
    sessionKey?: string;
  },
  now: string,
): SlackThreadRecord {
  const file = slackThreadsFile(workspaceRoot);
  const data = readJsonFile<SlackThreadMapFile>(file, emptyThreads());
  const idx = data.threads.findIndex((record) => record.key === input.key);
  const conversationId = input.conversationId ?? data.threads[idx]?.conversationId ?? threadConversationId(input.key);
  const sessionKey = input.sessionKey ?? data.threads[idx]?.sessionKey ?? `session:${conversationId}`;
  const record: SlackThreadRecord = {
    key: input.key,
    conversationId,
    sessionKey,
    repo: input.repo,
    teamId: input.teamId,
    channel: input.channel,
    threadTs: input.threadTs,
    updatedAt: now,
  };
  if (idx >= 0) data.threads[idx] = record;
  else data.threads.push(record);
  writeJsonFile(file, data);
  return record;
}

function buildSlackInstructions(event: TriggerEvent, context: SlackTriggerContext, continued: boolean): string {
  const lines = [
    `Slack trigger: ${event.kind} in ${context.channel || 'unknown-channel'} for ${event.repo}`,
    context.threadTs ? `Thread: ${context.threadTs}` : '',
    context.user || event.sender ? `Sender: ${context.user || event.sender}` : '',
    continued ? 'Continue the existing Slack thread conversation.' : 'Start a new Slack thread conversation.',
    '',
    context.text.trim(),
    '',
    '## Delivery',
    '- Implement the ask above in this repository.',
    '- Deliver the result as a reviewable draft PR; do not push to the default branch.',
  ].filter(Boolean);
  return redactSecrets(lines.join('\n')).slice(0, TRIGGER_INSTRUCTION_MAX_CHARS);
}

export async function resolveSlackTrigger(
  event: TriggerEvent,
  options: SlackResolveOptions,
): Promise<SlackResolveResult> {
  if (event.provider !== 'slack') return skip('not-slack');
  if (!event.repo) return skip('missing-repo');
  const payload = options.readPayload ? options.readPayload(event) : readTriggerPayload(event);
  const context = extractSlackTriggerContext(payload);
  if (!context.channel || !context.threadTs) return skip('missing-thread');
  const key = slackThreadKey(context.teamId, context.channel, context.threadTs);
  const existing = getSlackThreadRecord(options.workspaceRoot, key);
  const handle = options.mentionHandle?.trim() || DEFAULT_MENTION_HANDLE;
  const mentioned = event.kind === 'chat.mention' || containsMention(context.text, handle);
  if (!mentioned && !existing) return skip('no-mention-no-thread');

  const now = options.now?.() ?? new Date().toISOString();
  const thread = upsertSlackThreadRecord(options.workspaceRoot, {
    key,
    repo: event.repo,
    teamId: context.teamId,
    channel: context.channel,
    threadTs: context.threadTs,
  }, now);
  const continued = Boolean(existing);
  const job: CreateFleetJobInput = {
    kind: 'build',
    workspaceRoot: options.workspaceRoot,
    input: {
      source: 'trigger:slack',
      delivery: 'pr-emit',
      repo: event.repo,
      prompt: buildSlackInstructions(event, context, continued),
      title: `${event.repo}: Slack thread ${context.threadTs}`,
      slug: `slack-${context.channel}-${context.threadTs}`.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(),
      conversationId: thread.conversationId,
      sessionKey: thread.sessionKey,
      trigger: {
        provider: event.provider,
        kind: event.kind,
        repo: event.repo,
        sender: event.sender,
        deliveryId: event.deliveryId,
        receivedAt: event.receivedAt,
        teamId: context.teamId,
        channel: context.channel,
        threadTs: context.threadTs,
        messageTs: context.messageTs,
        conversationId: thread.conversationId,
        continued,
      },
    },
    idempotencyKey: event.deliveryId
      ? `trigger:slack:${event.deliveryId}`
      : `trigger:slack:${key}:${context.messageTs}`,
  };

  const enqueue = options.enqueue ?? ((input: CreateFleetJobInput) => enqueueFleetJob(input, { home: options.home }));
  const result = enqueue(job);
  const resolved: SlackResolveResult = result.deduped
    ? { action: 'deduped', reason: 'in-flight-duplicate', job: result.job, conversationId: thread.conversationId, continued }
    : { action: 'enqueued', job: result.job, conversationId: thread.conversationId, continued };
  return resolved;
}

export function createSlackTriggerSink(options: SlackResolveOptions): TriggerSink {
  return async (event: TriggerEvent) => {
    const result = await resolveSlackTrigger(event, options);
    options.onResolved?.(event, result);
  };
}
