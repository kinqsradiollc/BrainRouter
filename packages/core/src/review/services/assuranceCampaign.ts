/**
 * Bounded repository-assurance campaign service.
 *
 * The service creates one exact-revision run, advances stage receipts at safe
 * boundaries, honors cancellation, records explicit partial evidence, and
 * delegates all IO through host-neutral ports.
 */

import type {
  AssuranceCoverage,
  AssurancePolicySnapshot,
  AssuranceStageName,
  AssuranceStageReceipt,
  RepositoryAssuranceProgram,
  RepositoryAssuranceRun,
  RepositoryRef,
  RepositoryRevision,
  SourceSnapshot,
} from '@kinqs/brainrouter-types/review';
import { validateRepositoryAssuranceRun } from '../contracts/assuranceValidation.js';
import type {
  AssuranceCancellationPort,
  AssuranceCandidateVerifierPort,
  AssuranceFindingPort,
  RepositoryAssuranceRunPort,
} from '../ports/assurance.js';
import { verifyAssuranceCandidate } from './candidateVerification.js';

export interface AssuranceCampaignDependencies {
  runs: RepositoryAssuranceRunPort;
  findings?: AssuranceFindingPort;
  verifier?: AssuranceCandidateVerifierPort;
  cancellation?: AssuranceCancellationPort;
  now: () => string;
  nextId: (kind: 'run' | 'source' | 'stage') => string;
}

export interface StartAssuranceCampaignInput {
  repository: RepositoryRef;
  revision: RepositoryRevision;
  program: RepositoryAssuranceProgram;
  policySnapshot: AssurancePolicySnapshot;
}

export interface AssuranceStageExecutionResult {
  status: 'succeeded' | 'partial';
  source?: SourceSnapshot;
  coverage?: AssuranceCoverage;
  inputRefs?: string[];
  outputRefs?: string[];
  limitationIds?: string[];
  errorCode?: string;
}

export type AssuranceStageHandler = (
  run: RepositoryAssuranceRun,
) => Promise<AssuranceStageExecutionResult>;

function assertValidRun(run: RepositoryAssuranceRun): void {
  const validation = validateRepositoryAssuranceRun(run);
  if (!validation.ok) {
    throw new Error(`Repository assurance run is invalid: ${validation.issues.join('; ')}.`);
  }
}

function initialCoverage(now: string): AssuranceCoverage {
  return {
    status: 'unavailable',
    filesTotal: 0,
    filesEligible: 0,
    filesAnalyzed: 0,
    changedFilesTotal: 0,
    changedFilesAnalyzed: 0,
    analyzers: [],
    limitations: [],
    calculatedAt: now,
  };
}

function ensureActive(run: RepositoryAssuranceRun): void {
  if (run.status !== 'queued' && run.status !== 'running') {
    throw new Error(`Repository assurance run ${run.id} is already ${run.status}.`);
  }
}

function assertReceiptRevision(run: RepositoryAssuranceRun, source: SourceSnapshot): void {
  if (
    source.revision.headSha !== run.revision.headSha
    || source.revision.baseSha !== run.revision.baseSha
    || source.revision.mergeBaseSha !== run.revision.mergeBaseSha
  ) {
    throw new Error('Source receipt revision must match the campaign revision.');
  }
}

async function requireRun(
  port: RepositoryAssuranceRunPort,
  runId: string,
): Promise<RepositoryAssuranceRun> {
  const run = await port.get(runId);
  if (!run) throw new Error(`Repository assurance run ${runId} was not found.`);
  return run;
}

export class RepositoryAssuranceCampaignService {
  constructor(private readonly deps: AssuranceCampaignDependencies) {}

  async start(input: StartAssuranceCampaignInput): Promise<RepositoryAssuranceRun> {
    if (input.policySnapshot.program !== input.program) {
      throw new Error('Assurance policy program must match the requested campaign program.');
    }
    const now = this.deps.now();
    const run: RepositoryAssuranceRun = {
      id: this.deps.nextId('run'),
      repository: { ...input.repository },
      revision: { ...input.revision },
      program: input.program,
      policySnapshot: structuredClone(input.policySnapshot),
      sourceSnapshot: {
        id: this.deps.nextId('source'),
        revision: { ...input.revision },
        status: 'pending',
        fileCount: 0,
        textFileCount: 0,
        indexedFileCount: 0,
        unsupportedFileCount: 0,
        createdAt: now,
      },
      coverage: initialCoverage(now),
      stages: [],
      findings: [],
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    assertValidRun(run);
    const created = await this.deps.runs.create(run);
    if (!created.created) return created.run;
    return this.deps.runs.transition({
      runId: created.run.id,
      status: 'running',
      updatedAt: now,
    });
  }

  async runStage(
    runId: string,
    stage: AssuranceStageName,
    attempt: number,
    handler: AssuranceStageHandler,
  ): Promise<RepositoryAssuranceRun> {
    const run = await requireRun(this.deps.runs, runId);
    ensureActive(run);
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error('Assurance stage attempt must be a positive integer.');
    }
    // A stage attempt owns ONE receipt id for its whole life. Minting a fresh id
    // on every call looked harmless while stages only ran once, but an
    // interrupted stage does run again: `terminalStage()` reads a receipt left
    // `running` by a dead process as "unfinished, retry it", and the retry
    // arrives here with the SAME attempt number. The store then refuses it —
    // "A stage attempt cannot change its receipt id" — and the run can never
    // make progress again. One crash, one permanently unretryable run.
    //
    // So resume the existing receipt rather than replacing it, and refuse to
    // redo a stage that already finished: a terminal receipt is the record of
    // work that happened, and re-running it would overwrite an outcome with a
    // second opinion. `running` -> `running` is an allowed transition (the
    // store's `from === to` clause), which is what makes resuming legal.
    const previous = run.stages.find(
      (receipt) => receipt.stage === stage && receipt.attempt === attempt,
    );
    if (previous && previous.status !== 'running' && previous.status !== 'pending') {
      return run;
    }
    const startedAt = previous?.startedAt ?? this.deps.now();
    const stageId = previous?.id ?? this.deps.nextId('stage');
    if (await this.deps.cancellation?.isCancellationRequested(runId)) {
      await this.deps.runs.saveStage(runId, {
        id: stageId,
        stage,
        status: 'canceled',
        attempt,
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        inputRefs: [],
        outputRefs: [],
        limitationIds: [],
        errorCode: 'CANCELED',
      });
      return this.deps.runs.transition({
        runId,
        status: 'canceled',
        updatedAt: startedAt,
        completedAt: startedAt,
      });
    }

    const running: AssuranceStageReceipt = {
      id: stageId,
      stage,
      status: 'running',
      attempt,
      startedAt,
      inputRefs: [],
      outputRefs: [],
      limitationIds: [],
    };
    await this.deps.runs.saveStage(runId, running);
    try {
      const result = await handler(run);
      const completedAt = this.deps.now();
      if (await this.deps.cancellation?.isCancellationRequested(runId)) {
        await this.deps.runs.saveStage(runId, {
          ...running,
          status: 'canceled',
          completedAt,
          errorCode: 'CANCELED',
        });
        return this.deps.runs.transition({
          runId,
          status: 'canceled',
          updatedAt: completedAt,
          completedAt,
        });
      }
      const terminalStage: AssuranceStageReceipt = {
        ...running,
        status: result.status,
        completedAt,
        inputRefs: result.inputRefs ?? [],
        outputRefs: result.outputRefs ?? [],
        limitationIds: result.limitationIds ?? [],
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      };
      const candidate: RepositoryAssuranceRun = {
        ...run,
        sourceSnapshot: result.source ?? run.sourceSnapshot,
        coverage: result.coverage ?? run.coverage,
        stages: [
          ...run.stages.filter((receipt) =>
            receipt.stage !== stage || receipt.attempt !== attempt,
          ),
          terminalStage,
        ],
        updatedAt: completedAt,
      };
      assertValidRun(candidate);
      if (result.source) {
        assertReceiptRevision(run, result.source);
        await this.deps.runs.saveSource(runId, result.source);
      }
      if (result.coverage) {
        await this.deps.runs.saveCoverage(runId, result.coverage);
      }
      await this.deps.runs.saveStage(runId, terminalStage);
      return requireRun(this.deps.runs, runId);
    } catch (error) {
      const completedAt = this.deps.now();
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.runs.saveStage(runId, {
        ...running,
        status: 'failed',
        completedAt,
        errorCode: message.slice(0, 128) || 'STAGE_FAILED',
      });
      await this.deps.runs.transition({
        runId,
        status: 'failed',
        updatedAt: completedAt,
        completedAt,
      });
      throw error;
    }
  }

  async finish(
    runId: string,
    status: 'completed' | 'partial',
  ): Promise<RepositoryAssuranceRun> {
    const run = await requireRun(this.deps.runs, runId);
    ensureActive(run);
    const completedAt = this.deps.now();
    const candidate = {
      ...run,
      status,
      updatedAt: completedAt,
      completedAt,
    } satisfies RepositoryAssuranceRun;
    assertValidRun(candidate);
    return this.deps.runs.transition({
      runId,
      status,
      updatedAt: completedAt,
      completedAt,
    });
  }

  async cancel(runId: string): Promise<RepositoryAssuranceRun> {
    const run = await requireRun(this.deps.runs, runId);
    ensureActive(run);
    const completedAt = this.deps.now();
    return this.deps.runs.transition({
      runId,
      status: 'canceled',
      updatedAt: completedAt,
      completedAt,
    });
  }

  async supersede(runId: string, replacementRunId: string): Promise<RepositoryAssuranceRun> {
    const [run, replacement] = await Promise.all([
      requireRun(this.deps.runs, runId),
      requireRun(this.deps.runs, replacementRunId),
    ]);
    ensureActive(run);
    if (
      run.id === replacement.id
      || run.policySnapshot.organizationId !== replacement.policySnapshot.organizationId
      || run.repository.forge !== replacement.repository.forge
      || run.repository.slug.toLowerCase() !== replacement.repository.slug.toLowerCase()
      || run.program !== replacement.program
    ) {
      throw new Error('A replacement run must belong to the same tenant, repository, and program.');
    }
    const completedAt = this.deps.now();
    return this.deps.runs.transition({
      runId,
      status: 'superseded',
      supersededByRunId: replacementRunId,
      updatedAt: completedAt,
      completedAt,
    });
  }

  verifyCandidate(runId: string, findingId: string) {
    return verifyAssuranceCandidate(this.deps, runId, findingId);
  }
}

export function createRepositoryAssuranceCampaignService(
  deps: AssuranceCampaignDependencies,
): RepositoryAssuranceCampaignService {
  return new RepositoryAssuranceCampaignService(deps);
}
