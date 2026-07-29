import type { RepositoryAssuranceProgram, RepositoryRef } from './program.js';

export type DeepReviewProgram = Extract<
  RepositoryAssuranceProgram,
  'code_review' | 'security_review'
>;

export interface DeepReviewTelemetryThresholds {
  program: DeepReviewProgram;
  maxRepositoryFiles: number;
  minIndexedFileRatio: number;
  maxEstimatedModelCalls: number;
  maxEstimatedToolCalls: number;
  maxEstimatedDurationMs: number;
  maxEstimatedUsd: number;
  acceptedBy: string;
  acceptedAt: string;
}

export interface DeepReviewPolicy {
  schemaVersion: 1;
  policyHash: string;
  organizationId: string;
  repository: Pick<RepositoryRef, 'forge' | 'slug'>;
  program: DeepReviewProgram;
  activation: {
    mode: 'explicit_manual';
    requestedBy: string;
    automaticEscalation: false;
  };
  telemetryThresholds: DeepReviewTelemetryThresholds;
  packetLimits: {
    maxPackets: number;
    maxPacketBytes: number;
    maxFilesPerPacket: number;
  };
  budgets: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxDurationMs: number;
    maxUsd: number;
  };
  cancellation: {
    mode: 'cooperative_fail_closed';
    pollIntervalMs: number;
  };
  coverage: {
    scope: 'whole_repository';
    label: 'bounded_whole_repository';
    requireLimitations: true;
  };
  createdAt: string;
}

export interface DeepReviewTelemetry {
  repositoryFiles: number;
  eligibleFiles: number;
  indexedFiles: number;
  estimatedModelCalls: number;
  estimatedToolCalls: number;
  estimatedDurationMs: number;
  estimatedUsd: number;
}

export type DeepReviewActivationSource = 'manual_console' | 'manual_api' | 'diff_review';

export type DeepReviewActivationReason =
  | 'EXPLICIT_OPT_IN_REQUIRED'
  | 'AUTOMATIC_ESCALATION_FORBIDDEN'
  | 'PROGRAM_MISMATCH'
  | 'REPOSITORY_SCOPE_MISMATCH'
  | 'REPOSITORY_FILE_THRESHOLD_EXCEEDED'
  | 'INDEX_COVERAGE_THRESHOLD_NOT_MET'
  | 'MODEL_CALL_THRESHOLD_EXCEEDED'
  | 'TOOL_CALL_THRESHOLD_EXCEEDED'
  | 'DURATION_THRESHOLD_EXCEEDED'
  | 'COST_THRESHOLD_EXCEEDED'
  | 'TELEMETRY_INVALID';

export interface DeepReviewActivationDecision {
  eligible: boolean;
  coverageLabel: DeepReviewPolicy['coverage']['label'];
  reasons: DeepReviewActivationReason[];
}
