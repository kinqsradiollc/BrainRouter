import type { AssuranceCoverage } from './coverage.js';
import type { AssuranceFindingRef } from './finding.js';
import type {
  RepositoryAssuranceProgram,
  RepositoryRef,
  RepositoryRevision,
} from './program.js';
import type { SourceSnapshot } from './source.js';

export const ASSURANCE_STAGE_NAMES = [
  'authorize',
  'checkout_inventory',
  'index',
  'deterministic_analysis',
  'coverage_risk_map',
  'packet_assembly',
  'candidate_discovery',
  'candidate_verification',
  'lifecycle_gate',
  'publication',
] as const;

export type AssuranceStageName = (typeof ASSURANCE_STAGE_NAMES)[number];

export const ASSURANCE_STAGE_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
  'canceled',
] as const;

export type AssuranceStageStatus = (typeof ASSURANCE_STAGE_STATUSES)[number];

export interface AssuranceStageReceipt {
  id: string;
  stage: AssuranceStageName;
  status: AssuranceStageStatus;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputRefs: string[];
  outputRefs: string[];
  limitationIds: string[];
  errorCode?: string;
}

export interface AssurancePolicySnapshot {
  id: string;
  policyHash: string;
  organizationId: string;
  program: RepositoryAssuranceProgram;
  analyzers: Array<{ id: string; enabled: boolean; required: boolean }>;
  packetLimits: {
    maxPackets: number;
    maxPacketBytes: number;
    maxFilesPerPacket: number;
  };
  budgets: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxDurationMs: number;
  };
  redactionPolicyId: string;
  publicationPolicyId: string;
  inlineFindingsEnabled: boolean;
  blockingEnabled: boolean;
  createdAt: string;
}

export const ASSURANCE_RUN_STATUSES = [
  'queued',
  'running',
  'partial',
  'completed',
  'failed',
  'canceled',
  'superseded',
  'stale',
] as const;

export type AssuranceRunStatus = (typeof ASSURANCE_RUN_STATUSES)[number];

/** Durable unit of repository assurance for one exact revision and policy. */
export interface RepositoryAssuranceRun {
  id: string;
  repository: RepositoryRef;
  revision: RepositoryRevision;
  program: RepositoryAssuranceProgram;
  policySnapshot: AssurancePolicySnapshot;
  sourceSnapshot: SourceSnapshot;
  coverage: AssuranceCoverage;
  stages: AssuranceStageReceipt[];
  findings: AssuranceFindingRef[];
  status: AssuranceRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  supersededByRunId?: string;
  staleReason?: string;
}
