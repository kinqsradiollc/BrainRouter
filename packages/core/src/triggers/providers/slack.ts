import { createHmac, timingSafeEqual } from 'node:crypto';
import { readConnectorsAll } from '../../connectors/store/connectorStore.js';
import type {
  NormalizedTriggerEvent,
  TriggerProvider,
  TriggerVerifyInput,
} from '../triggerTypes.js';
import { firstHeaderValue } from '../triggerTypes.js';

export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const SIGNATURE_RE = /^v0=([0-9a-f]{64})$/i;
const MAX_SKEW_SECONDS = 5 * 60;

export function verifySlackSignature(input: TriggerVerifyInput): boolean {
  const secret = (input.secret ?? '').trim();
  if (!secret) return false;
  const timestamp = firstHeaderValue(input.headers[SLACK_TIMESTAMP_HEADER]);
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > MAX_SKEW_SECONDS) {
    return false;
  }
  const match = SIGNATURE_RE.exec(firstHeaderValue(input.headers[SLACK_SIGNATURE_HEADER]));
  if (!match) return false;
  const theirs = Buffer.from(match[1].toLowerCase(), 'hex');
  const base = `v0:${timestamp}:${input.rawBody.toString('utf8')}`;
  const ours = createHmac('sha256', secret).update(base).digest();
  if (theirs.length !== ours.length) return false;
  return timingSafeEqual(ours, theirs);
}

interface SlackPayloadShape {
  type?: unknown;
  team_id?: unknown;
  event_id?: unknown;
  repo?: unknown;
  repository?: { full_name?: unknown };
  event?: {
    type?: unknown;
    text?: unknown;
    channel?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    user?: unknown;
    bot_id?: unknown;
    repo?: unknown;
    repository?: { full_name?: unknown };
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function inferRepoFromSlackText(text: string): string {
  const explicit = /\brepo(?:sitory)?\s*[:=]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text);
  if (explicit) return explicit[1];
  const url = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text);
  if (url) return url[1].replace(/[).,;]+$/g, '');
  const bare = /(?:^|[\s(<])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[\s)>.,;])/i.exec(text);
  return bare ? bare[1] : '';
}

export function normalizeSlackEvent(
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
): NormalizedTriggerEvent | null {
  const body = (payload && typeof payload === 'object' ? payload : {}) as SlackPayloadShape;
  const deliveryId = str(body.event_id) ||
    (firstHeaderValue(headers['x-slack-retry-num'])
      ? `${firstHeaderValue(headers['x-slack-retry-num'])}:${firstHeaderValue(headers['x-slack-retry-reason'])}`
      : undefined);
  if (body.type === 'url_verification') return null;
  const ev = body.event;
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.bot_id === 'string' && ev.bot_id) return null;
  const eventType = str(ev.type).toLowerCase();
  if (eventType !== 'app_mention' && eventType !== 'message') return null;
  const text = str(ev.text);
  const repo = str(ev.repository?.full_name) || str(ev.repo) || str(body.repository?.full_name) || str(body.repo) || inferRepoFromSlackText(text);
  const sender = str(ev.user);
  const kind = eventType === 'app_mention' ? 'chat.mention' : 'chat.message';
  return { kind, repo, sender, deliveryId };
}

export const slackTriggerProvider: TriggerProvider = {
  name: 'slack',
  signatureHeader: SLACK_SIGNATURE_HEADER,
  verifySignature: verifySlackSignature,
  normalize: normalizeSlackEvent,
};

export function resolveSlackTriggerSecret(opts: {
  configSecret?: string;
  workspaceRoot?: string;
}): string {
  const explicit = (opts.configSecret ?? '').trim();
  if (explicit) return explicit;
  if (!opts.workspaceRoot) return '';
  try {
    for (const record of Object.values(readConnectorsAll(opts.workspaceRoot))) {
      if (record.source !== 'slack') continue;
      const candidate = record.config?.signingSecret;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Fail closed.
  }
  return '';
}
