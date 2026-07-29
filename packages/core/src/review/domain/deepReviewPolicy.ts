import { createHash } from 'node:crypto';
import type {
  DeepReviewActivationDecision,
  DeepReviewActivationReason,
  DeepReviewActivationSource,
  DeepReviewPolicy,
  DeepReviewProgram,
  DeepReviewTelemetry,
  DeepReviewTelemetryThresholds,
  RepositoryRef,
} from '@kinqs/brainrouter-types/review';

type DeepReviewPolicyPayload = Omit<DeepReviewPolicy, 'policyHash'>;

export const DEEP_REVIEW_HARD_LIMITS = Object.freeze({
  maxRepositoryFiles: 1_000_000,
  maxEstimatedModelCalls: 200,
  maxEstimatedToolCalls: 1_000,
  maxEstimatedDurationMs: 2 * 60 * 60_000,
  maxEstimatedUsd: 100,
  maxPackets: 200,
  maxPacketBytes: 64 * 1_024,
  maxFilesPerPacket: 50,
  maxCancellationPollIntervalMs: 60_000,
});

export interface BuildDeepReviewPolicyInput {
  organizationId: string;
  repository: Pick<RepositoryRef, 'forge' | 'slug'>;
  program: DeepReviewProgram;
  requestedBy: string;
  telemetryThresholds: DeepReviewTelemetryThresholds;
  packetLimits: DeepReviewPolicy['packetLimits'];
  budgets: DeepReviewPolicy['budgets'];
  cancellationPollIntervalMs?: number;
  now?: string;
}

export interface EvaluateDeepReviewActivationInput {
  policy: DeepReviewPolicy;
  organizationId: string;
  repository: Pick<RepositoryRef, 'forge' | 'slug'>;
  program: DeepReviewProgram;
  source: DeepReviewActivationSource;
  explicitRequest: boolean;
  telemetry: DeepReviewTelemetry;
}

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

function hashPolicy(payload: DeepReviewPolicyPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return number;
}

function positiveFinite(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return number;
}

function ratio(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    throw new Error(`${field} must be greater than zero and at most one.`);
  }
  return number;
}

function atMost(value: number, limit: number, field: string): number {
  if (value > limit) throw new Error(`${field} exceeds the platform limit.`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = nonEmpty(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function program(value: unknown): DeepReviewProgram {
  if (value !== 'code_review' && value !== 'security_review') {
    throw new Error('Deep review supports code_review or security_review only.');
  }
  return value;
}

function repository(
  value: Pick<RepositoryRef, 'forge' | 'slug'>,
): Pick<RepositoryRef, 'forge' | 'slug'> {
  if (!['github', 'gitlab', 'local'].includes(value?.forge)) {
    throw new Error('Deep-review repository forge is invalid.');
  }
  const slug = nonEmpty(value?.slug, 'repository.slug').toLowerCase();
  return { forge: value.forge, slug };
}

function thresholds(
  value: DeepReviewTelemetryThresholds,
  expectedProgram: DeepReviewProgram,
): DeepReviewTelemetryThresholds {
  const thresholdProgram = program(value?.program);
  if (thresholdProgram !== expectedProgram) {
    throw new Error('Deep-review telemetry thresholds must match the review program.');
  }
  return {
    program: thresholdProgram,
    maxRepositoryFiles: atMost(
      positiveInteger(value?.maxRepositoryFiles, 'maxRepositoryFiles'),
      DEEP_REVIEW_HARD_LIMITS.maxRepositoryFiles,
      'maxRepositoryFiles',
    ),
    minIndexedFileRatio: ratio(value?.minIndexedFileRatio, 'minIndexedFileRatio'),
    maxEstimatedModelCalls: atMost(
      positiveInteger(value?.maxEstimatedModelCalls, 'maxEstimatedModelCalls'),
      DEEP_REVIEW_HARD_LIMITS.maxEstimatedModelCalls,
      'maxEstimatedModelCalls',
    ),
    maxEstimatedToolCalls: atMost(
      positiveInteger(value?.maxEstimatedToolCalls, 'maxEstimatedToolCalls'),
      DEEP_REVIEW_HARD_LIMITS.maxEstimatedToolCalls,
      'maxEstimatedToolCalls',
    ),
    maxEstimatedDurationMs: atMost(
      positiveInteger(value?.maxEstimatedDurationMs, 'maxEstimatedDurationMs'),
      DEEP_REVIEW_HARD_LIMITS.maxEstimatedDurationMs,
      'maxEstimatedDurationMs',
    ),
    maxEstimatedUsd: atMost(
      positiveFinite(value?.maxEstimatedUsd, 'maxEstimatedUsd'),
      DEEP_REVIEW_HARD_LIMITS.maxEstimatedUsd,
      'maxEstimatedUsd',
    ),
    acceptedBy: nonEmpty(value?.acceptedBy, 'acceptedBy'),
    acceptedAt: isoTimestamp(value?.acceptedAt, 'acceptedAt'),
  };
}

function payload(input: BuildDeepReviewPolicyInput): DeepReviewPolicyPayload {
  const selectedProgram = program(input.program);
  const selectedThresholds = thresholds(input.telemetryThresholds, selectedProgram);
  const budgets = {
    maxModelCalls: positiveInteger(input.budgets?.maxModelCalls, 'budgets.maxModelCalls'),
    maxToolCalls: positiveInteger(input.budgets?.maxToolCalls, 'budgets.maxToolCalls'),
    maxDurationMs: positiveInteger(input.budgets?.maxDurationMs, 'budgets.maxDurationMs'),
    maxUsd: positiveFinite(input.budgets?.maxUsd, 'budgets.maxUsd'),
  };
  if (
    budgets.maxModelCalls > selectedThresholds.maxEstimatedModelCalls
    || budgets.maxToolCalls > selectedThresholds.maxEstimatedToolCalls
    || budgets.maxDurationMs > selectedThresholds.maxEstimatedDurationMs
    || budgets.maxUsd > selectedThresholds.maxEstimatedUsd
  ) {
    throw new Error('Deep-review budgets cannot exceed accepted telemetry thresholds.');
  }
  return {
    schemaVersion: 1,
    organizationId: nonEmpty(input.organizationId, 'organizationId'),
    repository: repository(input.repository),
    program: selectedProgram,
    activation: {
      mode: 'explicit_manual',
      requestedBy: nonEmpty(input.requestedBy, 'requestedBy'),
      automaticEscalation: false,
    },
    telemetryThresholds: selectedThresholds,
    packetLimits: {
      maxPackets: atMost(
        positiveInteger(input.packetLimits?.maxPackets, 'packetLimits.maxPackets'),
        DEEP_REVIEW_HARD_LIMITS.maxPackets,
        'packetLimits.maxPackets',
      ),
      maxPacketBytes: atMost(
        positiveInteger(input.packetLimits?.maxPacketBytes, 'packetLimits.maxPacketBytes'),
        DEEP_REVIEW_HARD_LIMITS.maxPacketBytes,
        'packetLimits.maxPacketBytes',
      ),
      maxFilesPerPacket: atMost(
        positiveInteger(input.packetLimits?.maxFilesPerPacket, 'packetLimits.maxFilesPerPacket'),
        DEEP_REVIEW_HARD_LIMITS.maxFilesPerPacket,
        'packetLimits.maxFilesPerPacket',
      ),
    },
    budgets,
    cancellation: {
      mode: 'cooperative_fail_closed',
      pollIntervalMs: atMost(
        positiveInteger(
          input.cancellationPollIntervalMs ?? 1_000,
          'cancellation.pollIntervalMs',
        ),
        DEEP_REVIEW_HARD_LIMITS.maxCancellationPollIntervalMs,
        'cancellation.pollIntervalMs',
      ),
    },
    coverage: {
      scope: 'whole_repository',
      label: 'bounded_whole_repository',
      requireLimitations: true,
    },
    createdAt: isoTimestamp(input.now ?? new Date().toISOString(), 'createdAt'),
  };
}

export function buildDeepReviewPolicy(input: BuildDeepReviewPolicyInput): DeepReviewPolicy {
  const value = payload(input);
  return { ...value, policyHash: hashPolicy(value) };
}

export function parseDeepReviewPolicy(value: unknown): DeepReviewPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A persisted deep-review policy is required.');
  }
  const policyValue = value as DeepReviewPolicy;
  if (policyValue.schemaVersion !== 1) throw new Error('Unsupported deep-review policy.');
  if (
    policyValue.activation?.mode !== 'explicit_manual'
    || policyValue.activation?.automaticEscalation !== false
  ) {
    throw new Error('Deep review requires explicit manual activation and forbids auto escalation.');
  }
  if (
    policyValue.cancellation?.mode !== 'cooperative_fail_closed'
    || policyValue.coverage?.scope !== 'whole_repository'
    || policyValue.coverage?.label !== 'bounded_whole_repository'
    || policyValue.coverage?.requireLimitations !== true
  ) {
    throw new Error('Deep-review cancellation or coverage policy is invalid.');
  }
  const parsedPayload = payload({
    organizationId: policyValue.organizationId,
    repository: policyValue.repository,
    program: policyValue.program,
    requestedBy: policyValue.activation.requestedBy,
    telemetryThresholds: policyValue.telemetryThresholds,
    packetLimits: policyValue.packetLimits,
    budgets: policyValue.budgets,
    cancellationPollIntervalMs: policyValue.cancellation.pollIntervalMs,
    now: policyValue.createdAt,
  });
  const expectedHash = hashPolicy(parsedPayload);
  if (policyValue.policyHash !== expectedHash) {
    throw new Error('Deep-review policy hash does not match its contents.');
  }
  return { ...parsedPayload, policyHash: expectedHash };
}

function indexedRatio(telemetry: DeepReviewTelemetry): number {
  if (telemetry.eligibleFiles <= 0) return 0;
  return telemetry.indexedFiles / telemetry.eligibleFiles;
}

function telemetryIsValid(telemetry: DeepReviewTelemetry): boolean {
  const counts = [
    telemetry.repositoryFiles,
    telemetry.eligibleFiles,
    telemetry.indexedFiles,
    telemetry.estimatedModelCalls,
    telemetry.estimatedToolCalls,
    telemetry.estimatedDurationMs,
  ];
  return counts.every((value) => Number.isInteger(value) && value >= 0)
    && Number.isFinite(telemetry.estimatedUsd)
    && telemetry.estimatedUsd >= 0
    && telemetry.eligibleFiles <= telemetry.repositoryFiles
    && telemetry.indexedFiles <= telemetry.eligibleFiles;
}

export function evaluateDeepReviewActivation(
  input: EvaluateDeepReviewActivationInput,
): DeepReviewActivationDecision {
  const selected = parseDeepReviewPolicy(input.policy);
  const reasons: DeepReviewActivationReason[] = [];
  if (!input.explicitRequest) reasons.push('EXPLICIT_OPT_IN_REQUIRED');
  if (input.source === 'diff_review') reasons.push('AUTOMATIC_ESCALATION_FORBIDDEN');
  if (input.program !== selected.program) reasons.push('PROGRAM_MISMATCH');
  const requestedRepository = repository(input.repository);
  if (
    input.organizationId !== selected.organizationId
    || requestedRepository.forge !== selected.repository.forge
    || requestedRepository.slug !== selected.repository.slug
  ) {
    reasons.push('REPOSITORY_SCOPE_MISMATCH');
  }
  if (!telemetryIsValid(input.telemetry)) {
    return {
      eligible: false,
      coverageLabel: selected.coverage.label,
      reasons: [...reasons, 'TELEMETRY_INVALID'],
    };
  }
  if (input.telemetry.repositoryFiles > selected.telemetryThresholds.maxRepositoryFiles) {
    reasons.push('REPOSITORY_FILE_THRESHOLD_EXCEEDED');
  }
  if (indexedRatio(input.telemetry) < selected.telemetryThresholds.minIndexedFileRatio) {
    reasons.push('INDEX_COVERAGE_THRESHOLD_NOT_MET');
  }
  if (
    input.telemetry.estimatedModelCalls > selected.telemetryThresholds.maxEstimatedModelCalls
    || input.telemetry.estimatedModelCalls > selected.budgets.maxModelCalls
  ) {
    reasons.push('MODEL_CALL_THRESHOLD_EXCEEDED');
  }
  if (
    input.telemetry.estimatedToolCalls > selected.telemetryThresholds.maxEstimatedToolCalls
    || input.telemetry.estimatedToolCalls > selected.budgets.maxToolCalls
  ) {
    reasons.push('TOOL_CALL_THRESHOLD_EXCEEDED');
  }
  if (
    input.telemetry.estimatedDurationMs > selected.telemetryThresholds.maxEstimatedDurationMs
    || input.telemetry.estimatedDurationMs > selected.budgets.maxDurationMs
  ) {
    reasons.push('DURATION_THRESHOLD_EXCEEDED');
  }
  if (
    input.telemetry.estimatedUsd > selected.telemetryThresholds.maxEstimatedUsd
    || input.telemetry.estimatedUsd > selected.budgets.maxUsd
  ) {
    reasons.push('COST_THRESHOLD_EXCEEDED');
  }
  return {
    eligible: reasons.length === 0,
    coverageLabel: selected.coverage.label,
    reasons,
  };
}
