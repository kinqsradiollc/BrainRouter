/**
 * Backend adapter from the Core assurance-run port to durable store methods.
 *
 * The adapter binds one worker job and organization, keeping tenant ancestry
 * out of Core while preventing a scheduler input from selecting another org.
 */

import type {
  AssuranceCoverage,
  AssuranceStageReceipt,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import type {
  AssuranceRunCreateResult,
  AssuranceRunTransitionInput,
  RepositoryAssuranceRunPort,
} from "@kinqs/brainrouter-core/review";

export interface RepositoryAssurancePersistenceStore {
  createRepositoryAssuranceRun(input: {
    jobId: string;
    run: RepositoryAssuranceRun;
  }): Promise<RepositoryAssuranceRun>;
  getRepositoryAssuranceRun(
    orgId: string,
    runId: string,
  ): Promise<RepositoryAssuranceRun | null>;
  transitionRepositoryAssuranceRun(input: {
    orgId: string;
    runId: string;
    status: RepositoryAssuranceRun["status"];
    updatedAt?: string;
    completedAt?: string;
    supersededByRunId?: string;
    staleReason?: string;
  }): Promise<RepositoryAssuranceRun>;
  updateRepositorySourceSnapshot(
    orgId: string,
    runId: string,
    source: SourceSnapshot,
  ): Promise<SourceSnapshot>;
  updateRepositoryAssuranceCoverage(
    orgId: string,
    runId: string,
    coverage: AssuranceCoverage,
  ): Promise<AssuranceCoverage>;
  recordRepositoryAssuranceStage(
    orgId: string,
    runId: string,
    stage: AssuranceStageReceipt,
  ): Promise<AssuranceStageReceipt>;
}

export interface BackendAssuranceRunPortContext {
  organizationId: string;
  jobId: string;
}

export class BackendAssuranceRunPort implements RepositoryAssuranceRunPort {
  constructor(
    private readonly store: RepositoryAssurancePersistenceStore,
    private readonly context: BackendAssuranceRunPortContext,
  ) {
    if (!context.organizationId.trim()) {
      throw new Error("Assurance run port organization id must be non-empty.");
    }
    if (!context.jobId.trim()) {
      throw new Error("Assurance run port job id must be non-empty.");
    }
  }

  async create(run: RepositoryAssuranceRun): Promise<AssuranceRunCreateResult> {
    if (run.policySnapshot.organizationId !== this.context.organizationId) {
      throw new Error("Assurance run policy organization does not match the bound worker tenant.");
    }
    const persisted = await this.store.createRepositoryAssuranceRun({
      jobId: this.context.jobId,
      run,
    });
    return {
      run: persisted,
      created: persisted.id === run.id,
    };
  }

  get(runId: string): Promise<RepositoryAssuranceRun | null> {
    return this.store.getRepositoryAssuranceRun(this.context.organizationId, runId);
  }

  saveSource(runId: string, source: SourceSnapshot): Promise<SourceSnapshot> {
    return this.store.updateRepositorySourceSnapshot(
      this.context.organizationId,
      runId,
      source,
    );
  }

  saveCoverage(runId: string, coverage: AssuranceCoverage): Promise<AssuranceCoverage> {
    return this.store.updateRepositoryAssuranceCoverage(
      this.context.organizationId,
      runId,
      coverage,
    );
  }

  saveStage(runId: string, stage: AssuranceStageReceipt): Promise<AssuranceStageReceipt> {
    return this.store.recordRepositoryAssuranceStage(
      this.context.organizationId,
      runId,
      stage,
    );
  }

  transition(input: AssuranceRunTransitionInput): Promise<RepositoryAssuranceRun> {
    return this.store.transitionRepositoryAssuranceRun({
      orgId: this.context.organizationId,
      ...input,
    });
  }
}

export function createBackendAssuranceRunPort(
  store: RepositoryAssurancePersistenceStore,
  context: BackendAssuranceRunPortContext,
): BackendAssuranceRunPort {
  return new BackendAssuranceRunPort(store, context);
}
