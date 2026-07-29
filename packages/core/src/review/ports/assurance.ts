/**
 * Host-neutral ports for repository-assurance campaigns.
 *
 * Core owns orchestration and policy while hosts supply persistence, candidate
 * verification, cancellation, and lifecycle projection. No Git, database,
 * queue, provider SDK, or presentation type crosses this boundary.
 */

import type {
  AssuranceCoverage,
  AssuranceFinding,
  AssuranceStageReceipt,
  AssuranceVerifierDisposition,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from '@kinqs/brainrouter-types/review';
import type {
  LifecycleCurrentFinding,
  LifecycleFindingInput,
  LifecycleTransition,
} from '../domain/findingLifecycle.js';

export interface AssuranceRunCreateResult {
  run: RepositoryAssuranceRun;
  created: boolean;
}

export interface AssuranceRunTransitionInput {
  runId: string;
  status: RepositoryAssuranceRun['status'];
  updatedAt: string;
  completedAt?: string;
  supersededByRunId?: string;
  staleReason?: string;
}

export interface RepositoryAssuranceRunPort {
  create(run: RepositoryAssuranceRun): Promise<AssuranceRunCreateResult>;
  get(runId: string): Promise<RepositoryAssuranceRun | null>;
  saveSource(runId: string, source: SourceSnapshot): Promise<SourceSnapshot>;
  saveCoverage(runId: string, coverage: AssuranceCoverage): Promise<AssuranceCoverage>;
  saveStage(runId: string, stage: AssuranceStageReceipt): Promise<AssuranceStageReceipt>;
  transition(input: AssuranceRunTransitionInput): Promise<RepositoryAssuranceRun>;
}

export interface AssuranceFindingPort {
  get(findingId: string): Promise<AssuranceFinding | null>;
  save(finding: AssuranceFinding): Promise<AssuranceFinding>;
}

export interface AssuranceCandidateVerifierPort {
  verify(input: {
    run: RepositoryAssuranceRun;
    finding: AssuranceFinding;
  }): Promise<AssuranceVerifierDisposition>;
}

export interface AssuranceCancellationPort {
  isCancellationRequested(runId: string): boolean | Promise<boolean>;
}

export interface AssuranceLifecycleScope {
  organizationId: string;
  repository: string;
  program: RepositoryAssuranceRun['program'];
}

export interface AssuranceFindingLifecyclePort {
  listCurrent(scope: AssuranceLifecycleScope): Promise<LifecycleCurrentFinding[]>;
  apply(
    scope: AssuranceLifecycleScope,
    transitions: LifecycleTransition[],
  ): Promise<void>;
}

export interface ReconcileAssuranceLifecycleInput {
  scope: AssuranceLifecycleScope;
  incoming: LifecycleFindingInput[];
  complete: boolean;
}
