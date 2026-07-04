import { timingSafeEqual } from 'node:crypto';
import { readConnectorsAll } from '../../connectors/store/connectorStore.js';
import type { NormalizedTriggerEvent, TriggerProvider, TriggerVerifyInput } from '../triggerTypes.js';
import { firstHeaderValue } from '../triggerTypes.js';

export const GITLAB_SIGNATURE_HEADER = 'x-gitlab-token';

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyGitlabSignature(input: TriggerVerifyInput): boolean {
  const secret = (input.secret ?? '').trim();
  if (!secret) return false;
  const token = firstHeaderValue(input.headers[GITLAB_SIGNATURE_HEADER]);
  return Boolean(token) && safeEqualString(token, secret);
}

interface GitlabPayloadShape {
  object_kind?: unknown;
  event_type?: unknown;
  project?: { path_with_namespace?: unknown };
  user?: { username?: unknown; name?: unknown };
  user_username?: unknown;
  issue?: { iid?: unknown };
  merge_request?: { iid?: unknown };
  object_attributes?: {
    action?: unknown;
    iid?: unknown;
    noteable_iid?: unknown;
    target_iid?: unknown;
    source_branch?: unknown;
    status?: unknown;
    labels?: unknown;
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function hasLabels(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function normalizeGitlabEvent(
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
): NormalizedTriggerEvent | null {
  const body = (payload && typeof payload === 'object' ? payload : {}) as GitlabPayloadShape;
  const objectKind = (str(body.object_kind) || str(body.event_type) || firstHeaderValue(headers['x-gitlab-event'])).toLowerCase();
  if (!objectKind) return null;
  const attrs = body.object_attributes ?? {};
  const action = str(attrs.action).toLowerCase();
  const repo = str(body.project?.path_with_namespace);
  const sender = str(body.user?.username) || str(body.user_username) || str(body.user?.name);
  const number = num(attrs.iid) ?? num(attrs.noteable_iid) ?? num(attrs.target_iid) ?? num(body.issue?.iid) ?? num(body.merge_request?.iid);

  let kind: string;
  if (objectKind.includes('note')) {
    kind = 'comment.created';
  } else if (objectKind.includes('merge_request')) {
    if (action === 'open' || action === 'opened') kind = 'pull_request.opened';
    else if (action === 'update' && hasLabels(attrs.labels)) kind = 'pull_request.labeled';
    else kind = action ? `pull_request.${action}` : 'pull_request';
  } else if (objectKind.includes('issue')) {
    if (action === 'open' || action === 'opened') kind = 'issue.opened';
    else if ((action === 'update' || action === 'reopen') && hasLabels(attrs.labels)) kind = 'issue.labeled';
    else kind = action ? `issue.${action}` : 'issue';
  } else if (objectKind.includes('pipeline')) {
    kind = 'workflow_run.completed';
  } else {
    kind = action ? `${objectKind}.${action}` : objectKind.replace(/\s+/g, '_');
  }
  return { kind, repo, number, sender };
}

export const gitlabTriggerProvider: TriggerProvider = {
  name: 'gitlab',
  signatureHeader: GITLAB_SIGNATURE_HEADER,
  verifySignature: verifyGitlabSignature,
  normalize: normalizeGitlabEvent,
};

export function resolveGitlabTriggerSecret(opts: { configSecret?: string; workspaceRoot?: string }): string {
  const explicit = (opts.configSecret ?? '').trim();
  if (explicit) return explicit;
  if (!opts.workspaceRoot) return '';
  try {
    for (const record of Object.values(readConnectorsAll(opts.workspaceRoot))) {
      if (record.source !== 'gitlab') continue;
      const candidate = record.config?.webhookSecret ?? record.config?.signingSecret;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Fail closed.
  }
  return '';
}
