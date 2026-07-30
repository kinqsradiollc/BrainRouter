import { createHash } from 'node:crypto';
import type {
  AuthorizedAssessmentPolicy,
  AuthorizedAssessmentScanMode,
} from '@kinqs/brainrouter-types/review';
import type { PentestTargetRecord } from '@kinqs/brainrouter-types';
import { PENTEST_SCAN_MODES } from '../pentestReview.js';

const DEFAULT_EVIDENCE_RETENTION_DAYS = 30;
const DEFAULT_CANCELLATION_POLL_MS = 1_000;

export interface BuildAuthorizedAssessmentPolicyOptions {
  scanMode: AuthorizedAssessmentScanMode;
  maxUsd?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  evidenceRetentionDays?: number;
  cancellationPollIntervalMs?: number;
  now?: string;
}

type PolicyPayload = Omit<AuthorizedAssessmentPolicy, 'policyHash'>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPolicy(payload: PolicyPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function positiveFinite(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return number;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = nonEmpty(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeTarget(kind: 'domain' | 'repository', value: string): string {
  if (kind === 'domain') {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Authorized domain targets must use http(s).');
    }
    return parsed.origin.toLowerCase();
  }
  const repository = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('Authorized repository targets must be owner/repository.');
  }
  return repository;
}

export function buildAuthorizedAssessmentPolicy(
  target: PentestTargetRecord,
  options: BuildAuthorizedAssessmentPolicyOptions,
): AuthorizedAssessmentPolicy {
  if (target.kind === 'domain' && options.scanMode === 'code-review') {
    throw new Error('Domain targets cannot use source-only code-review mode.');
  }
  const mode = PENTEST_SCAN_MODES[options.scanMode];
  const normalizedValue = normalizeTarget(target.kind, target.normalizedValue);
  const maxDurationMs = options.maxDurationMs ?? mode.timeoutFloorMs;
  const payload: PolicyPayload = {
    schemaVersion: 1,
    program: 'authorized_pentest',
    organizationId: nonEmpty(target.orgId, 'organizationId'),
    target: {
      targetId: nonEmpty(target.id, 'targetId'),
      kind: target.kind,
      normalizedValue,
    },
    authorization: {
      authorizedBy: nonEmpty(target.createdBy, 'authorizedBy'),
      authorizedAt: isoTimestamp(target.authorizedAt, 'authorizedAt'),
    },
    perimeter: {
      liveNetwork: target.kind === 'domain' && options.scanMode !== 'code-review',
      allowedOrigins: target.kind === 'domain' ? [normalizedValue] : [],
      allowedRepositories: target.kind === 'repository' ? [normalizedValue] : [],
    },
    budget: {
      maxUsd: positiveFinite(options.maxUsd ?? mode.budgetUSD, 'maxUsd'),
      maxTokens: Math.floor(positiveFinite(options.maxTokens ?? mode.tokenCap, 'maxTokens')),
      maxDurationMs: Math.floor(positiveFinite(maxDurationMs, 'maxDurationMs')),
    },
    cancellation: {
      mode: 'cooperative_fail_closed',
      pollIntervalMs: Math.floor(positiveFinite(
        options.cancellationPollIntervalMs ?? DEFAULT_CANCELLATION_POLL_MS,
        'cancellationPollIntervalMs',
      )),
    },
    evidence: {
      retentionDays: Math.floor(positiveFinite(
        options.evidenceRetentionDays ?? DEFAULT_EVIDENCE_RETENTION_DAYS,
        'evidenceRetentionDays',
      )),
      redactSecrets: true,
      rawRequestRetention: 'none',
    },
    scanMode: options.scanMode,
    createdAt: isoTimestamp(options.now ?? new Date().toISOString(), 'createdAt'),
  };
  return { ...payload, policyHash: hashPolicy(payload) };
}

export function parseAuthorizedAssessmentPolicy(
  value: unknown,
): AuthorizedAssessmentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A persisted authorized-assessment policy is required.');
  }
  const policy = value as AuthorizedAssessmentPolicy;
  if (policy.schemaVersion !== 1 || policy.program !== 'authorized_pentest') {
    throw new Error('Unsupported authorized-assessment policy.');
  }
  if (!['code-review', 'standard', 'full-audit'].includes(policy.scanMode)) {
    throw new Error('Authorized-assessment scanMode is invalid.');
  }
  if (policy.target?.kind !== 'domain' && policy.target?.kind !== 'repository') {
    throw new Error('Authorized-assessment target kind is invalid.');
  }
  const payload: PolicyPayload = {
    schemaVersion: 1,
    program: 'authorized_pentest',
    organizationId: nonEmpty(policy.organizationId, 'organizationId'),
    target: {
      targetId: nonEmpty(policy.target?.targetId, 'targetId'),
      kind: policy.target?.kind,
      normalizedValue: normalizeTarget(
        policy.target?.kind,
        nonEmpty(policy.target?.normalizedValue, 'normalizedValue'),
      ),
    },
    authorization: {
      authorizedBy: nonEmpty(policy.authorization?.authorizedBy, 'authorizedBy'),
      authorizedAt: isoTimestamp(policy.authorization?.authorizedAt, 'authorizedAt'),
    },
    perimeter: {
      liveNetwork: policy.perimeter?.liveNetwork === true,
      allowedOrigins: Array.isArray(policy.perimeter?.allowedOrigins)
        ? policy.perimeter.allowedOrigins.map((entry) => normalizeTarget('domain', entry))
        : [],
      allowedRepositories: Array.isArray(policy.perimeter?.allowedRepositories)
        ? policy.perimeter.allowedRepositories.map((entry) => normalizeTarget('repository', entry))
        : [],
    },
    budget: {
      maxUsd: positiveFinite(policy.budget?.maxUsd, 'maxUsd'),
      maxTokens: Math.floor(positiveFinite(policy.budget?.maxTokens, 'maxTokens')),
      maxDurationMs: Math.floor(positiveFinite(policy.budget?.maxDurationMs, 'maxDurationMs')),
    },
    cancellation: {
      mode: policy.cancellation?.mode,
      pollIntervalMs: Math.floor(positiveFinite(
        policy.cancellation?.pollIntervalMs,
        'cancellationPollIntervalMs',
      )),
    },
    evidence: {
      retentionDays: Math.floor(positiveFinite(
        policy.evidence?.retentionDays,
        'evidenceRetentionDays',
      )),
      redactSecrets: policy.evidence?.redactSecrets,
      rawRequestRetention: policy.evidence?.rawRequestRetention,
    },
    scanMode: policy.scanMode,
    createdAt: isoTimestamp(policy.createdAt, 'createdAt'),
  };

  if (payload.cancellation.mode !== 'cooperative_fail_closed') {
    throw new Error('Authorized assessments require fail-closed cancellation.');
  }
  if (
    payload.evidence.redactSecrets !== true
    || payload.evidence.rawRequestRetention !== 'none'
  ) {
    throw new Error('Authorized-assessment evidence policy is not safe.');
  }
  if (payload.target.kind === 'domain') {
    if (
      !payload.perimeter.liveNetwork
      || payload.perimeter.allowedOrigins.length !== 1
      || payload.perimeter.allowedOrigins[0] !== payload.target.normalizedValue
      || payload.perimeter.allowedRepositories.length !== 0
    ) {
      throw new Error('Authorized domain assessment perimeter does not match its target.');
    }
  } else if (
    payload.perimeter.liveNetwork
    || payload.perimeter.allowedRepositories.length !== 1
    || payload.perimeter.allowedRepositories[0] !== payload.target.normalizedValue
    || payload.perimeter.allowedOrigins.length !== 0
  ) {
    throw new Error('Authorized repository assessment perimeter does not match its target.');
  }

  const expectedHash = hashPolicy(payload);
  if (policy.policyHash !== expectedHash) {
    throw new Error('Authorized-assessment policy hash does not match its contents.');
  }
  return { ...payload, policyHash: expectedHash };
}

export function assertAuthorizedAssessmentTarget(
  policy: AuthorizedAssessmentPolicy,
  target: PentestTargetRecord | null,
): void {
  if (
    !target
    || target.id !== policy.target.targetId
    || target.orgId !== policy.organizationId
    || target.kind !== policy.target.kind
    || normalizeTarget(target.kind, target.normalizedValue) !== policy.target.normalizedValue
    || target.createdBy !== policy.authorization.authorizedBy
    || new Date(target.authorizedAt).toISOString() !== policy.authorization.authorizedAt
  ) {
    throw new Error('Authorized-assessment target is missing, revoked, or changed.');
  }
}
