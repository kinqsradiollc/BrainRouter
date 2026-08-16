/**
 * A25-8c — in-memory repository-assurance campaign port fixtures.
 *
 * These tests prove exact-revision idempotency, stage receipts, cancellation,
 * partial/complete termination, thrown-stage failure, and verifier evidence
 * without importing a host, queue, database, Git, or provider SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssuranceCoverage,
  AssuranceFinding,
  AssurancePolicySnapshot,
  AssuranceStageReceipt,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from '@kinqs/brainrouter-types/review';
import {
  createRepositoryAssuranceCampaignService,
  type AssuranceRunCreateResult,
  type AssuranceRunTransitionInput,
  type RepositoryAssuranceRunPort,
} from '../review/index.js';

const T0 = '2026-07-29T00:00:00.000Z';
const T1 = '2026-07-29T00:01:00.000Z';
const T2 = '2026-07-29T00:02:00.000Z';
const T3 = '2026-07-29T00:03:00.000Z';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function semanticKey(run: RepositoryAssuranceRun): string {
  return [
    run.policySnapshot.organizationId,
    run.repository.forge,
    run.repository.slug.toLowerCase(),
    run.program,
    run.revision.baseSha ?? '',
    run.revision.headSha,
    run.revision.mergeBaseSha ?? '',
    run.policySnapshot.policyHash,
  ].join('\0');
}

class InMemoryRunPort implements RepositoryAssuranceRunPort {
  readonly runs = new Map<string, RepositoryAssuranceRun>();
  readonly bySemanticKey = new Map<string, string>();

  async create(run: RepositoryAssuranceRun): Promise<AssuranceRunCreateResult> {
    const key = semanticKey(run);
    const existingId = this.bySemanticKey.get(key);
    if (existingId) return { run: clone(this.runs.get(existingId)!), created: false };
    this.runs.set(run.id, clone(run));
    this.bySemanticKey.set(key, run.id);
    return { run: clone(run), created: true };
  }

  async get(runId: string): Promise<RepositoryAssuranceRun | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async saveSource(runId: string, source: SourceSnapshot): Promise<SourceSnapshot> {
    const run = this.runs.get(runId)!;
    run.sourceSnapshot = clone(source);
    run.updatedAt = source.completedAt ?? source.createdAt;
    return clone(source);
  }

  async saveCoverage(runId: string, coverage: AssuranceCoverage): Promise<AssuranceCoverage> {
    const run = this.runs.get(runId)!;
    run.coverage = clone(coverage);
    run.updatedAt = coverage.calculatedAt;
    return clone(coverage);
  }

  async saveStage(runId: string, stage: AssuranceStageReceipt): Promise<AssuranceStageReceipt> {
    const run = this.runs.get(runId)!;
    const index = run.stages.findIndex((candidate) =>
      candidate.stage === stage.stage && candidate.attempt === stage.attempt,
    );
    if (index >= 0) run.stages[index] = clone(stage);
    else run.stages.push(clone(stage));
    return clone(stage);
  }

  async transition(input: AssuranceRunTransitionInput): Promise<RepositoryAssuranceRun> {
    const run = this.runs.get(input.runId)!;
    run.status = input.status;
    run.updatedAt = input.updatedAt;
    if (input.completedAt) run.completedAt = input.completedAt;
    if (input.supersededByRunId) run.supersededByRunId = input.supersededByRunId;
    if (input.staleReason) run.staleReason = input.staleReason;
    return clone(run);
  }
}

function policy(): AssurancePolicySnapshot {
  return {
    id: 'policy-1',
    policyHash: 'policy-hash',
    organizationId: 'org-1',
    program: 'security_review',
    analyzers: [{ id: 'analyzer-1', enabled: true, required: true }],
    packetLimits: { maxPackets: 10, maxPacketBytes: 10_000, maxFilesPerPacket: 10 },
    budgets: { maxModelCalls: 10, maxToolCalls: 20, maxDurationMs: 60_000 },
    redactionPolicyId: 'redaction-1',
    publicationPolicyId: 'publication-1',
    inlineFindingsEnabled: true,
    blockingEnabled: true,
    createdAt: T0,
  };
}

function harness(options?: {
  cancellation?: () => boolean;
  findings?: Map<string, AssuranceFinding>;
}) {
  const runs = new InMemoryRunPort();
  const times = [T0, T1, T2, T3, T3, T3];
  const counters = { run: 0, source: 0, stage: 0 };
  const findings = options?.findings ?? new Map<string, AssuranceFinding>();
  const service = createRepositoryAssuranceCampaignService({
    runs,
    now: () => times.shift() ?? T3,
    nextId: (kind) => `${kind}-${++counters[kind]}`,
    ...(options?.cancellation
      ? { cancellation: { isCancellationRequested: options.cancellation } }
      : {}),
    findings: {
      get: async (id) => findings.get(id) ? clone(findings.get(id)!) : null,
      save: async (finding) => {
        findings.set(finding.id, clone(finding));
        return clone(finding);
      },
    },
    verifier: {
      verify: async ({ finding }) => ({
        state: 'verified',
        verifierId: 'deterministic-verifier',
        rationale: 'The anchored path is independently supported.',
        evidenceRefs: finding.evidence.map((evidence) => evidence.id),
        decidedAt: T3,
      }),
    },
  });
  return { runs, service, findings };
}

async function start(
  service: ReturnType<typeof createRepositoryAssuranceCampaignService>,
): Promise<RepositoryAssuranceRun> {
  return service.start({
    repository: { forge: 'github', slug: 'owner/repository', repositoryId: 'repo-1' },
    revision: { baseSha: 'base', headSha: 'head', mergeBaseSha: 'merge' },
    program: 'security_review',
    policySnapshot: policy(),
  });
}

function readySource(run: RepositoryAssuranceRun): SourceSnapshot {
  return {
    ...run.sourceSnapshot,
    status: 'ready',
    checkoutRef: 'checkout:head',
    inventoryRef: 'inventory:head',
    fileCount: 10,
    textFileCount: 9,
    indexedFileCount: 9,
    unsupportedFileCount: 1,
    completedAt: T2,
  };
}

function completeCoverage(): AssuranceCoverage {
  return {
    status: 'complete',
    filesTotal: 10,
    filesEligible: 9,
    filesAnalyzed: 9,
    changedFilesTotal: 2,
    changedFilesAnalyzed: 2,
    analyzers: [{
      analyzerId: 'analyzer-1',
      state: 'covered',
      supportedLanguages: ['typescript'],
      filesEligible: 9,
      filesAnalyzed: 9,
      diagnosticsProduced: 0,
      limitationIds: [],
    }],
    limitations: [],
    calculatedAt: T2,
  };
}

test('A25-8c start is idempotent for one exact revision and policy', async () => {
  const { runs, service } = harness();
  const first = await start(service);
  const second = await start(service);
  assert.equal(first.id, second.id);
  assert.equal(first.status, 'running');
  assert.equal(runs.runs.size, 1);
  assert.deepEqual(first.revision, { baseSha: 'base', headSha: 'head', mergeBaseSha: 'merge' });
});

test('A25-8c partial stage evidence remains explicit and cannot become completed', async () => {
  const { service } = harness();
  const running = await start(service);
  const staged = await service.runStage(
    running.id,
    'deterministic_analysis',
    1,
    async (run) => ({
      status: 'partial',
      source: { ...readySource(run), status: 'partial', errorCode: 'INDEX_PARTIAL' },
      coverage: {
        ...completeCoverage(),
        status: 'partial',
        filesAnalyzed: 7,
        changedFilesAnalyzed: 1,
        analyzers: [{
          ...completeCoverage().analyzers[0]!,
          state: 'partial',
          filesAnalyzed: 7,
          limitationIds: ['limitation-1'],
        }],
        limitations: [{
          id: 'limitation-1',
          component: 'analyzer-1',
          state: 'partial',
          reasonCode: 'INDEX_PARTIAL',
          summary: 'The index covered only part of the revision.',
        }],
      },
      outputRefs: ['analysis:partial'],
      limitationIds: ['limitation-1'],
      errorCode: 'INDEX_PARTIAL',
    }),
  );
  assert.equal(staged.stages[0]?.status, 'partial');
  const partial = await service.finish(running.id, 'partial');
  assert.equal(partial.status, 'partial');
  await assert.rejects(service.finish(running.id, 'completed'), /already partial/);
});

test('A25-8c completed campaigns require ready source and complete coverage', async () => {
  const { service } = harness();
  const running = await start(service);
  await assert.rejects(service.finish(running.id, 'completed'), /completed runs require/);
  await service.runStage(running.id, 'checkout_inventory', 1, async (run) => ({
    status: 'succeeded',
    source: readySource(run),
    coverage: completeCoverage(),
    outputRefs: ['inventory:head'],
  }));
  const completed = await service.finish(running.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sourceSnapshot.status, 'ready');
  assert.equal(completed.coverage.status, 'complete');
});

test('A25-8c cancellation stops before invoking a stage handler', async () => {
  let called = false;
  const { service } = harness({ cancellation: () => true });
  const running = await start(service);
  const canceled = await service.runStage(running.id, 'authorize', 1, async () => {
    called = true;
    return { status: 'succeeded' };
  });
  assert.equal(called, false);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.stages[0]?.status, 'canceled');
});

test('A25-10e explicit cancellation allows cleanup to finish at a safe boundary first', async () => {
  const { service } = harness();
  const running = await start(service);
  const cleaned = await service.runStage(running.id, 'cleanup', 1, async () => ({
    status: 'succeeded',
    inputRefs: ['checkout:head', 'index:head'],
    outputRefs: ['released:checkout:head', 'released:index:head'],
  }));
  assert.equal(cleaned.status, 'running');
  assert.equal(cleaned.stages[0]?.stage, 'cleanup');
  assert.equal(cleaned.stages[0]?.status, 'succeeded');

  const canceled = await service.cancel(running.id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.completedAt, T3);
});

test('A25-8c thrown stage work records failure and leaves a terminal run', async () => {
  const { service } = harness();
  const running = await start(service);
  await assert.rejects(
    service.runStage(running.id, 'index', 1, async () => {
      throw new Error('index unavailable');
    }),
    /index unavailable/,
  );
  await assert.rejects(service.finish(running.id, 'partial'), /already failed/);
});

test('A25-8c supersession requires a same-scope replacement run', async () => {
  const { service } = harness();
  const first = await start(service);
  const replacement = await service.start({
    repository: { forge: 'github', slug: 'owner/repository', repositoryId: 'repo-1' },
    revision: { baseSha: 'base', headSha: 'new-head', mergeBaseSha: 'merge' },
    program: 'security_review',
    policySnapshot: policy(),
  });
  const superseded = await service.supersede(first.id, replacement.id);
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.supersededByRunId, replacement.id);
});

test('A25-8c candidate verification requires matching current-revision evidence', async () => {
  const candidate: AssuranceFinding = {
    id: 'finding-1',
    fingerprint: 'fingerprint-1',
    program: 'security_review',
    revisionSha: 'head',
    state: 'candidate',
    severity: 'high',
    confidence: 0.8,
    title: 'Unsafe source reaches a sensitive sink',
    mechanism: 'source_to_sink',
    location: { path: 'src/handler.ts', line: 20 },
    evidence: [{
      id: 'evidence-1',
      kind: 'call_path',
      summary: 'handler -> service -> sink',
      revisionSha: 'head',
      createdAt: T1,
    }],
    provenance: [{
      producerKind: 'deterministic_analyzer',
      producerId: 'analyzer-1',
      policyHash: 'policy-hash',
      createdAt: T1,
    }],
    coverageLimitations: [],
    createdAt: T1,
    updatedAt: T1,
  };
  const source = new Map([[candidate.id, candidate]]);
  const { service } = harness({ findings: source });
  const running = await start(service);
  const verified = await service.verifyCandidate(running.id, candidate.id);
  assert.equal(verified.state, 'verified');
  assert.deepEqual(verified.verifier?.evidenceRefs, ['evidence-1']);
  assert.equal(verified.revisionSha, running.revision.headSha);
});

/**
 * A stage interrupted mid-flight must stay retryable.
 *
 * This is the shape that took PR review down for four days. A process that dies
 * inside a stage leaves its receipt `running`; `terminalStage()` in
 * `diffReviewAssurance` reads `running` as "unfinished — retry it", so the retry
 * arrives with the SAME attempt number. `runStage` used to mint a fresh receipt
 * id every call, and the store refuses that outright:
 *
 *     A stage attempt cannot change its receipt id.
 *
 * The run could then never make progress again. Not a rare race — ANY crash,
 * restart or OOM mid-stage produced it, and the wedge is permanent.
 *
 * So the attempt keeps ONE receipt id for its whole life: a retry RESUMES it.
 */
test('an interrupted stage resumes its receipt instead of minting a second id', async () => {
  const { runs, service } = harness();
  const running = await start(service);

  // The process dies inside the stage: a `running` receipt, never completed.
  await runs.saveStage(running.id, {
    id: 'stage-interrupted',
    stage: 'index',
    status: 'running',
    attempt: 1,
    startedAt: T0,
    inputRefs: [],
    outputRefs: [],
    limitationIds: [],
  } as AssuranceStageReceipt);

  const before = (await runs.get(running.id))!.stages.filter((r) => r.stage === 'index');
  assert.equal(before.length, 1);
  assert.equal(before[0]!.status, 'running');

  // The retry: same stage, same attempt — exactly what terminalStage() drives.
  const after = await service.runStage(running.id, 'index', 1, async (run) => ({
    status: 'succeeded',
    source: readySource(run),
    coverage: completeCoverage(),
    outputRefs: [],
    limitationIds: [],
  }));

  const receipts = after.stages.filter((r) => r.stage === 'index' && r.attempt === 1);
  assert.equal(receipts.length, 1, 'the retry must not create a second receipt for one attempt');
  assert.equal(receipts[0]!.id, 'stage-interrupted',
    'the retry must RESUME the interrupted receipt id, not mint a new one');
  assert.equal(receipts[0]!.status, 'succeeded', 'the retry must be able to finish the stage');
});

test('a stage that already finished is not redone by a repeat call', async () => {
  const { runs, service } = harness();
  const running = await start(service);

  await service.runStage(running.id, 'index', 1, async (run) => ({
    status: 'succeeded',
    source: readySource(run),
    coverage: completeCoverage(),
    outputRefs: ['first-result'],
    limitationIds: [],
  }));

  // A terminal receipt is the record of work that HAPPENED. Re-running it would
  // overwrite a real outcome with a second opinion, and the handler below would
  // report a different result — so it must not run at all.
  let handlerRan = false;
  const after = await service.runStage(running.id, 'index', 1, async (run) => {
    handlerRan = true;
    return {
      status: 'partial',
      source: readySource(run),
      coverage: completeCoverage(),
      outputRefs: ['second-result'],
      limitationIds: [],
    };
  });

  assert.equal(handlerRan, false, 'a terminal stage must not be executed twice');
  const receipts = after.stages.filter((r) => r.stage === 'index' && r.attempt === 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'succeeded');
  assert.deepEqual(receipts[0]!.outputRefs, ['first-result'], 'the first outcome must survive');
  void runs;
});
