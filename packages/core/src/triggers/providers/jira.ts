import { createHmac, timingSafeEqual } from 'node:crypto';
import { readConnectorsAll } from '../../connectors/store/connectorStore.js';
import type { NormalizedTriggerEvent, TriggerProvider, TriggerVerifyInput } from '../triggerTypes.js';
import { firstHeaderValue } from '../triggerTypes.js';

export const JIRA_SIGNATURE_HEADER = 'x-atlassian-webhook-signature';
const SIGNATURE_RE = /^(?:sha256=)?([0-9a-f]{64})$/i;

export function verifyJiraSignature(input: TriggerVerifyInput): boolean {
  const secret = (input.secret ?? '').trim();
  if (!secret) return false;
  const match = SIGNATURE_RE.exec(firstHeaderValue(input.headers[JIRA_SIGNATURE_HEADER]));
  if (!match) return false;
  const theirs = Buffer.from(match[1].toLowerCase(), 'hex');
  const ours = createHmac('sha256', secret).update(input.rawBody).digest();
  return theirs.length === ours.length && timingSafeEqual(ours, theirs);
}

interface JiraPayloadShape {
  webhookEvent?: unknown;
  repo?: unknown;
  repository?: { full_name?: unknown };
  user?: { name?: unknown; displayName?: unknown; accountId?: unknown };
  comment?: { id?: unknown; body?: unknown };
  issue?: {
    id?: unknown;
    key?: unknown;
    fields?: {
      summary?: unknown;
      description?: unknown;
      labels?: unknown;
      repository?: unknown;
      project?: { key?: unknown };
    };
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function inferRepoFromText(text: string): string {
  const explicit = /\brepo(?:sitory)?\s*[:=]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text);
  if (explicit) return explicit[1];
  const url = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text);
  if (url) return url[1].replace(/[).,;]+$/g, '');
  const bare = /(?:^|[\s(<])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[\s)>.,;])/i.exec(text);
  return bare ? bare[1] : '';
}

function repoFromPayload(body: JiraPayloadShape): string {
  const fields = body.issue?.fields;
  return str(body.repository?.full_name) ||
    str(body.repo) ||
    str(fields?.repository) ||
    inferRepoFromText(`${str(body.comment?.body)} ${str(fields?.description)} ${str(fields?.summary)}`);
}

export function normalizeJiraEvent(
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
): NormalizedTriggerEvent | null {
  const body = (payload && typeof payload === 'object' ? payload : {}) as JiraPayloadShape;
  const eventName = (str(body.webhookEvent) || firstHeaderValue(headers['x-event-key'])).toLowerCase();
  if (!eventName) return null;
  let kind: string;
  if (eventName.includes('comment_created')) kind = 'comment.created';
  else if (eventName.includes('issue_created')) kind = 'issue.opened';
  else if (eventName.includes('issue_updated') && Array.isArray(body.issue?.fields?.labels)) kind = 'issue.labeled';
  else if (eventName.includes('issue_updated')) kind = 'issue.updated';
  else kind = eventName.replace(/^jira:/, '').replace(/_/g, '.');
  const sender = str(body.user?.name) || str(body.user?.accountId) || str(body.user?.displayName);
  return {
    kind,
    repo: repoFromPayload(body),
    number: num(body.issue?.id),
    sender,
    deliveryId: firstHeaderValue(headers['x-atlassian-webhook-identifier']) || undefined,
  };
}

export const jiraTriggerProvider: TriggerProvider = {
  name: 'jira',
  signatureHeader: JIRA_SIGNATURE_HEADER,
  verifySignature: verifyJiraSignature,
  normalize: normalizeJiraEvent,
};

export function resolveJiraTriggerSecret(opts: { configSecret?: string; workspaceRoot?: string }): string {
  const explicit = (opts.configSecret ?? '').trim();
  if (explicit) return explicit;
  if (!opts.workspaceRoot) return '';
  try {
    for (const record of Object.values(readConnectorsAll(opts.workspaceRoot))) {
      if (record.source !== 'jira') continue;
      const candidate = record.config?.webhookSecret ?? record.config?.signingSecret;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Fail closed.
  }
  return '';
}
