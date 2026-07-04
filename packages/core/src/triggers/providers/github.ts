/**
 * MC-B1 — GitHub trigger provider: `X-Hub-Signature-256` verification
 * (HMAC-SHA256, timing-safe) + payload normalization to the neutral
 * `TriggerEvent` shape.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readConnectorsAll } from '../../connectors/store/connectorStore.js';
import type {
  NormalizedTriggerEvent,
  TriggerProvider,
  TriggerVerifyInput,
} from '../triggerTypes.js';
import { firstHeaderValue } from '../triggerTypes.js';

export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';

/** `sha256=<64 hex chars>` — anything else is malformed and rejected. */
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;

/**
 * Verify a GitHub webhook delivery. Fail-closed on every edge: unset secret,
 * missing header, malformed header, digest-length mismatch. The comparison is
 * `timingSafeEqual` over the decoded digest bytes so the check leaks no
 * timing signal about how much of the signature matched.
 */
export function verifyGithubSignature(input: TriggerVerifyInput): boolean {
  const secret = (input.secret ?? '').trim();
  if (!secret) return false; // no secret configured → nothing is trusted
  const header = firstHeaderValue(input.headers[GITHUB_SIGNATURE_HEADER]);
  const match = SIGNATURE_RE.exec(header);
  if (!match) return false;
  const theirs = Buffer.from(match[1].toLowerCase(), 'hex');
  const ours = createHmac('sha256', secret).update(input.rawBody).digest();
  if (theirs.length !== ours.length) return false;
  return timingSafeEqual(ours, theirs);
}

interface GithubPayloadShape {
  action?: unknown;
  repository?: { full_name?: unknown };
  sender?: { login?: unknown };
  issue?: { number?: unknown };
  pull_request?: { number?: unknown };
  workflow_run?: { pull_requests?: Array<{ number?: unknown }> };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Map GitHub's `X-GitHub-Event` + `payload.action` onto the neutral kinds.
 * Pairs we do not explicitly name keep a `<event>.<action>` shape so future
 * resolvers can subscribe without an ingress change.
 */
export function normalizeGithubEvent(
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
): NormalizedTriggerEvent | null {
  const eventName = firstHeaderValue(headers['x-github-event']).toLowerCase();
  if (!eventName) return null;
  const body = (payload && typeof payload === 'object' ? payload : {}) as GithubPayloadShape;
  const action = asString(body.action).toLowerCase();
  const repo = asString(body.repository?.full_name);
  const sender = asString(body.sender?.login);
  const number =
    asNumber(body.issue?.number) ??
    asNumber(body.pull_request?.number) ??
    asNumber(body.workflow_run?.pull_requests?.[0]?.number);

  let kind: string;
  switch (eventName) {
    case 'ping':
      kind = 'ping';
      break;
    case 'issues':
      kind = action ? `issue.${action}` : 'issue';
      break;
    case 'issue_comment':
      kind = action === 'created' ? 'comment.created' : `comment.${action || 'unknown'}`;
      break;
    case 'pull_request_review_comment':
      kind = 'review.comment';
      break;
    case 'workflow_run':
      kind = action ? `workflow_run.${action}` : 'workflow_run';
      break;
    default:
      kind = action ? `${eventName}.${action}` : eventName;
      break;
  }
  return { kind, repo, number, sender };
}

/** The registered `github` adapter (see `registry.ts`). */
export const githubTriggerProvider: TriggerProvider = {
  name: 'github',
  signatureHeader: GITHUB_SIGNATURE_HEADER,
  verifySignature: verifyGithubSignature,
  normalize: normalizeGithubEvent,
};

/**
 * Resolve the GitHub webhook secret: the explicit `cli.triggers.githubSecret`
 * knob wins; otherwise fall back to a `webhookSecret` config value on the
 * workspace's GitHub connector (the connector store is where integration
 * secrets already live). '' = no secret → every delivery is rejected.
 */
export function resolveGithubTriggerSecret(opts: {
  configSecret?: string;
  workspaceRoot?: string;
}): string {
  const explicit = (opts.configSecret ?? '').trim();
  if (explicit) return explicit;
  if (!opts.workspaceRoot) return '';
  try {
    for (const record of Object.values(readConnectorsAll(opts.workspaceRoot))) {
      if (record.source !== 'github') continue;
      const candidate = record.config?.webhookSecret;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Fail-closed: an unreadable store means "no secret", never "skip verify".
  }
  return '';
}
