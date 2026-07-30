/**
 * Browser-safe projection of a durable repository-assurance run.
 *
 * This protocol package remains dependency-free: the view is a structural
 * subset of the shared record and contains no gate, transition, or persistence
 * policy. Hosts can render explicit degraded states without importing Core.
 */

export const ASSURANCE_PROGRAM_VIEWS = [
  'code_review',
  'security_review',
  'authorized_pentest',
] as const;
export type AssuranceProgramView = (typeof ASSURANCE_PROGRAM_VIEWS)[number];

export const ASSURANCE_RUN_STATUS_VIEWS = [
  'queued',
  'running',
  'partial',
  'completed',
  'failed',
  'canceled',
  'superseded',
  'stale',
] as const;
export type AssuranceRunStatusView = (typeof ASSURANCE_RUN_STATUS_VIEWS)[number];

export const ASSURANCE_SOURCE_STATUS_VIEWS = [
  'pending',
  'ready',
  'partial',
  'failed',
  'stale',
] as const;
export type AssuranceSourceStatusView = (typeof ASSURANCE_SOURCE_STATUS_VIEWS)[number];

export const ASSURANCE_COVERAGE_STATUS_VIEWS = [
  'complete',
  'partial',
  'unavailable',
] as const;
export type AssuranceCoverageStatusView = (typeof ASSURANCE_COVERAGE_STATUS_VIEWS)[number];

export const ASSURANCE_COMPONENT_STATUS_VIEWS = [
  'covered',
  'partial',
  'disabled',
  'unsupported',
  'unavailable',
  'failed',
] as const;
export type AssuranceComponentStatusView = (typeof ASSURANCE_COMPONENT_STATUS_VIEWS)[number];

export const ASSURANCE_STAGE_STATUS_VIEWS = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
  'canceled',
] as const;
export type AssuranceStageStatusView = (typeof ASSURANCE_STAGE_STATUS_VIEWS)[number];

export interface AssuranceRunEventView {
  id: string;
  organizationId: string;
  repository: {
    forge: 'github' | 'gitlab' | 'local';
    slug: string;
    repositoryId?: string;
  };
  revision: {
    headSha: string;
    baseSha?: string;
    mergeBaseSha?: string;
  };
  program: AssuranceProgramView;
  policy: {
    id: string;
    hash: string;
    blockingEnabled: boolean;
  };
  source: {
    id: string;
    status: AssuranceSourceStatusView;
    fileCount: number;
    textFileCount: number;
    indexedFileCount: number;
    unsupportedFileCount: number;
    checkoutRef?: string;
    inventoryRef?: string;
    errorCode?: string;
  };
  coverage: {
    status: AssuranceCoverageStatusView;
    filesTotal: number;
    filesEligible: number;
    filesAnalyzed: number;
    changedFilesTotal: number;
    changedFilesAnalyzed: number;
    analyzers: Array<{
      id: string;
      state: AssuranceComponentStatusView;
      filesEligible: number;
      filesAnalyzed: number;
      diagnosticsProduced: number;
    }>;
    limitations: Array<{
      id: string;
      component: string;
      state: Exclude<AssuranceComponentStatusView, 'covered'>;
      reasonCode: string;
      summary: string;
    }>;
    calculatedAt: string;
  };
  stages: Array<{
    id: string;
    name: string;
    status: AssuranceStageStatusView;
    attempt: number;
    errorCode?: string;
  }>;
  status: AssuranceRunStatusView;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  supersededByRunId?: string;
  staleReason?: string;
}

export type AssuranceRunEventAction =
  | 'created'
  | 'updated'
  | 'status-changed'
  | 'receipt-updated';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function validSource(value: unknown): boolean {
  const source = record(value);
  return !!source
    && nonEmpty(source.id)
    && oneOf(source.status, ASSURANCE_SOURCE_STATUS_VIEWS)
    && ['fileCount', 'textFileCount', 'indexedFileCount', 'unsupportedFileCount']
      .every((key) => nonNegativeInteger(source[key]));
}

function validCoverage(value: unknown): boolean {
  const coverage = record(value);
  if (
    !coverage
    || !oneOf(coverage.status, ASSURANCE_COVERAGE_STATUS_VIEWS)
    || !nonEmpty(coverage.calculatedAt)
    || !Array.isArray(coverage.analyzers)
    || !Array.isArray(coverage.limitations)
  ) return false;
  if (!['filesTotal', 'filesEligible', 'filesAnalyzed', 'changedFilesTotal', 'changedFilesAnalyzed']
    .every((key) => nonNegativeInteger(coverage[key]))) return false;
  if (Number(coverage.filesAnalyzed) > Number(coverage.filesEligible)) return false;
  if (Number(coverage.changedFilesAnalyzed) > Number(coverage.changedFilesTotal)) return false;
  return coverage.analyzers.every((value) => {
    const analyzer = record(value);
    return !!analyzer
      && nonEmpty(analyzer.id)
      && oneOf(analyzer.state, ASSURANCE_COMPONENT_STATUS_VIEWS)
      && ['filesEligible', 'filesAnalyzed', 'diagnosticsProduced']
        .every((key) => nonNegativeInteger(analyzer[key]));
  }) && coverage.limitations.every((value) => {
    const limitation = record(value);
    return !!limitation
      && nonEmpty(limitation.id)
      && nonEmpty(limitation.component)
      && oneOf(limitation.state, ASSURANCE_COMPONENT_STATUS_VIEWS)
      && limitation.state !== 'covered'
      && nonEmpty(limitation.reasonCode)
      && nonEmpty(limitation.summary);
  });
}

/** Structural guard for untrusted assurance event payloads. Pure. */
export function isAssuranceRunEventView(value: unknown): value is AssuranceRunEventView {
  const run = record(value);
  const repository = record(run?.repository);
  const revision = record(run?.revision);
  const policy = record(run?.policy);
  return !!run
    && nonEmpty(run.id)
    && nonEmpty(run.organizationId)
    && !!repository
    && oneOf(repository.forge, ['github', 'gitlab', 'local'])
    && nonEmpty(repository.slug)
    && !!revision
    && nonEmpty(revision.headSha)
    && oneOf(run.program, ASSURANCE_PROGRAM_VIEWS)
    && !!policy
    && nonEmpty(policy.id)
    && nonEmpty(policy.hash)
    && typeof policy.blockingEnabled === 'boolean'
    && validSource(run.source)
    && validCoverage(run.coverage)
    && Array.isArray(run.stages)
    && run.stages.every((value) => {
      const stage = record(value);
      return !!stage
        && nonEmpty(stage.id)
        && nonEmpty(stage.name)
        && oneOf(stage.status, ASSURANCE_STAGE_STATUS_VIEWS)
        && Number.isInteger(stage.attempt)
        && Number(stage.attempt) > 0;
    })
    && oneOf(run.status, ASSURANCE_RUN_STATUS_VIEWS)
    && nonEmpty(run.createdAt)
    && nonEmpty(run.updatedAt)
    && (run.status !== 'superseded' || nonEmpty(run.supersededByRunId))
    && (run.status !== 'stale' || nonEmpty(run.staleReason));
}
