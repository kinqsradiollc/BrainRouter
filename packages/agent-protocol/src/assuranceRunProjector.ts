import {
  ASSURANCE_COMPONENT_STATUS_VIEWS,
  ASSURANCE_COVERAGE_STATUS_VIEWS,
  ASSURANCE_PROGRAM_VIEWS,
  ASSURANCE_RUN_STATUS_VIEWS,
  ASSURANCE_SOURCE_STATUS_VIEWS,
  ASSURANCE_STAGE_STATUS_VIEWS,
  isAssuranceRunEventView,
  type AssuranceRunEventView,
} from './assurance.js';
import {
  nonEmpty,
  nonNegativeInteger,
  oneOf,
  optionalNonEmpty,
  positiveInteger,
  projectLimitation,
  record,
} from './assuranceDetailValidation.js';

export function projectAssuranceRun(value: unknown): AssuranceRunEventView | null {
  const run = record(value);
  const repository = record(run?.repository);
  const revision = record(run?.revision);
  const policy = record(run?.policySnapshot);
  const source = record(run?.sourceSnapshot);
  const coverage = record(run?.coverage);
  if (
    !run
    || !repository
    || !revision
    || !policy
    || !source
    || !coverage
    || !nonEmpty(run.id)
    || !oneOf(repository.forge, ['github', 'gitlab', 'local'])
    || !nonEmpty(repository.slug)
    || !optionalNonEmpty(repository.repositoryId)
    || !nonEmpty(revision.headSha)
    || !optionalNonEmpty(revision.baseSha)
    || !optionalNonEmpty(revision.mergeBaseSha)
    || !oneOf(run.program, ASSURANCE_PROGRAM_VIEWS)
    || !nonEmpty(policy.organizationId)
    || !nonEmpty(policy.id)
    || !nonEmpty(policy.policyHash)
    || typeof policy.blockingEnabled !== 'boolean'
    || !nonEmpty(source.id)
    || !oneOf(source.status, ASSURANCE_SOURCE_STATUS_VIEWS)
    || !['fileCount', 'textFileCount', 'indexedFileCount', 'unsupportedFileCount']
      .every((key) => nonNegativeInteger(source[key]))
    || !optionalNonEmpty(source.checkoutRef)
    || !optionalNonEmpty(source.inventoryRef)
    || !optionalNonEmpty(source.errorCode)
    || !oneOf(coverage.status, ASSURANCE_COVERAGE_STATUS_VIEWS)
    || !['filesTotal', 'filesEligible', 'filesAnalyzed', 'changedFilesTotal', 'changedFilesAnalyzed']
      .every((key) => nonNegativeInteger(coverage[key]))
    || !Array.isArray(coverage.analyzers)
    || !Array.isArray(coverage.limitations)
    || !nonEmpty(coverage.calculatedAt)
    || !Array.isArray(run.stages)
    || !oneOf(run.status, ASSURANCE_RUN_STATUS_VIEWS)
    || !nonEmpty(run.createdAt)
    || !nonEmpty(run.updatedAt)
    || !optionalNonEmpty(run.completedAt)
    || !optionalNonEmpty(run.supersededByRunId)
    || !optionalNonEmpty(run.staleReason)
  ) return null;

  const analyzers = coverage.analyzers.map((value) => {
    const analyzer = record(value);
    if (
      !analyzer
      || !nonEmpty(analyzer.analyzerId)
      || !oneOf(analyzer.state, ASSURANCE_COMPONENT_STATUS_VIEWS)
      || !['filesEligible', 'filesAnalyzed', 'diagnosticsProduced']
        .every((key) => nonNegativeInteger(analyzer[key]))
    ) return null;
    return {
      id: analyzer.analyzerId,
      state: analyzer.state,
      filesEligible: analyzer.filesEligible as number,
      filesAnalyzed: analyzer.filesAnalyzed as number,
      diagnosticsProduced: analyzer.diagnosticsProduced as number,
    };
  });
  const limitations = coverage.limitations.map(projectLimitation);
  const stages = run.stages.map((value) => {
    const stage = record(value);
    if (
      !stage
      || !nonEmpty(stage.id)
      || !nonEmpty(stage.stage)
      || !oneOf(stage.status, ASSURANCE_STAGE_STATUS_VIEWS)
      || !positiveInteger(stage.attempt)
      || !optionalNonEmpty(stage.errorCode)
    ) return null;
    return {
      id: stage.id,
      name: stage.stage,
      status: stage.status,
      attempt: stage.attempt,
      ...(stage.errorCode === undefined ? {} : { errorCode: stage.errorCode }),
    };
  });
  if (
    analyzers.some((item) => item === null)
    || limitations.some((item) => item === null)
    || stages.some((item) => item === null)
  ) return null;

  const projected: AssuranceRunEventView = {
    id: run.id,
    organizationId: policy.organizationId,
    repository: {
      forge: repository.forge,
      slug: repository.slug,
      ...(repository.repositoryId === undefined ? {} : { repositoryId: repository.repositoryId }),
    },
    revision: {
      headSha: revision.headSha,
      ...(revision.baseSha === undefined ? {} : { baseSha: revision.baseSha }),
      ...(revision.mergeBaseSha === undefined ? {} : { mergeBaseSha: revision.mergeBaseSha }),
    },
    program: run.program,
    policy: {
      id: policy.id,
      hash: policy.policyHash,
      blockingEnabled: policy.blockingEnabled,
    },
    source: {
      id: source.id,
      status: source.status,
      fileCount: source.fileCount as number,
      textFileCount: source.textFileCount as number,
      indexedFileCount: source.indexedFileCount as number,
      unsupportedFileCount: source.unsupportedFileCount as number,
      ...(source.checkoutRef === undefined ? {} : { checkoutRef: source.checkoutRef }),
      ...(source.inventoryRef === undefined ? {} : { inventoryRef: source.inventoryRef }),
      ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode }),
    },
    coverage: {
      status: coverage.status,
      filesTotal: coverage.filesTotal as number,
      filesEligible: coverage.filesEligible as number,
      filesAnalyzed: coverage.filesAnalyzed as number,
      changedFilesTotal: coverage.changedFilesTotal as number,
      changedFilesAnalyzed: coverage.changedFilesAnalyzed as number,
      analyzers: analyzers as AssuranceRunEventView['coverage']['analyzers'],
      limitations: limitations as AssuranceRunEventView['coverage']['limitations'],
      calculatedAt: coverage.calculatedAt,
    },
    stages: stages as AssuranceRunEventView['stages'],
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.supersededByRunId === undefined ? {} : { supersededByRunId: run.supersededByRunId }),
    ...(run.staleReason === undefined ? {} : { staleReason: run.staleReason }),
  };
  return isAssuranceRunEventView(projected) ? projected : null;
}
