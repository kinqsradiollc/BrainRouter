/**
 * Runtime validation for dependency-free repository-assurance records.
 *
 * Types owns the wire vocabulary; Core owns validation and cross-field
 * invariants before a host or adapter treats decoded data as authoritative.
 */

import {
  ASSURANCE_COVERAGE_STATES,
  ASSURANCE_FINDING_STATES,
  ASSURANCE_RUN_STATUSES,
  ASSURANCE_SEVERITIES,
  ASSURANCE_STAGE_NAMES,
  ASSURANCE_STAGE_STATUSES,
  REPOSITORY_ASSURANCE_PROGRAMS,
  SOURCE_SNAPSHOT_STATUSES,
  type RepositoryAssuranceRun,
} from '@kinqs/brainrouter-types/review';
import {
  checkForbiddenSecretKeys,
  checkString,
  nonEmpty,
  nonNegativeInteger,
  oneOf,
  record,
} from './validationHelpers.js';

export interface AssuranceValidationResult {
  ok: boolean;
  issues: string[];
}

function checkCoverage(value: unknown, issues: string[]): void {
  const coverage = record(value);
  if (!coverage) {
    issues.push('coverage must be an object');
    return;
  }
  if (!oneOf(coverage.status, ['complete', 'partial', 'unavailable'])) {
    issues.push('coverage.status is invalid');
  }
  for (const key of [
    'filesTotal',
    'filesEligible',
    'filesAnalyzed',
    'changedFilesTotal',
    'changedFilesAnalyzed',
  ]) {
    if (!nonNegativeInteger(coverage[key])) issues.push(`coverage.${key} must be a non-negative integer`);
  }
  if (
    nonNegativeInteger(coverage.filesEligible)
    && nonNegativeInteger(coverage.filesAnalyzed)
    && Number(coverage.filesAnalyzed) > Number(coverage.filesEligible)
  ) {
    issues.push('coverage.filesAnalyzed cannot exceed filesEligible');
  }
  if (
    nonNegativeInteger(coverage.changedFilesTotal)
    && nonNegativeInteger(coverage.changedFilesAnalyzed)
    && Number(coverage.changedFilesAnalyzed) > Number(coverage.changedFilesTotal)
  ) {
    issues.push('coverage.changedFilesAnalyzed cannot exceed changedFilesTotal');
  }
  if (!Array.isArray(coverage.analyzers)) {
    issues.push('coverage.analyzers must be an array');
  } else {
    coverage.analyzers.forEach((raw, index) => {
      const analyzer = record(raw);
      if (!analyzer) {
        issues.push(`coverage.analyzers[${index}] must be an object`);
        return;
      }
      checkString(analyzer, 'analyzerId', `coverage.analyzers[${index}]`, issues);
      if (!oneOf(analyzer.state, ASSURANCE_COVERAGE_STATES)) {
        issues.push(`coverage.analyzers[${index}].state is invalid`);
      }
    });
  }
  if (!Array.isArray(coverage.limitations)) {
    issues.push('coverage.limitations must be an array');
  } else {
    coverage.limitations.forEach((raw, index) => {
      const limitation = record(raw);
      if (!limitation) {
        issues.push(`coverage.limitations[${index}] must be an object`);
        return;
      }
      checkString(limitation, 'id', `coverage.limitations[${index}]`, issues);
      if (
        !oneOf(limitation.state, ASSURANCE_COVERAGE_STATES)
        || limitation.state === 'covered'
      ) {
        issues.push(`coverage.limitations[${index}].state must describe a limitation`);
      }
    });
  }
}

/** Validate an untrusted decoded run and all authority-relevant invariants. */
export function validateRepositoryAssuranceRun(value: unknown): AssuranceValidationResult {
  const issues: string[] = [];
  const run = record(value);
  if (!run) return { ok: false, issues: ['run must be an object'] };
  checkForbiddenSecretKeys(run, issues);

  checkString(run, 'id', 'run', issues);
  if (!oneOf(run.program, REPOSITORY_ASSURANCE_PROGRAMS)) issues.push('run.program is invalid');
  if (!oneOf(run.status, ASSURANCE_RUN_STATUSES)) issues.push('run.status is invalid');
  checkString(run, 'createdAt', 'run', issues);
  checkString(run, 'updatedAt', 'run', issues);

  const repository = record(run.repository);
  if (!repository) {
    issues.push('repository must be an object');
  } else {
    if (!oneOf(repository.forge, ['github', 'gitlab', 'local'])) issues.push('repository.forge is invalid');
    checkString(repository, 'slug', 'repository', issues);
  }

  const revision = record(run.revision);
  if (!revision) {
    issues.push('revision must be an object');
  } else {
    checkString(revision, 'headSha', 'revision', issues);
  }

  const policy = record(run.policySnapshot);
  if (!policy) {
    issues.push('policySnapshot must be an object');
  } else {
    checkString(policy, 'id', 'policySnapshot', issues);
    checkString(policy, 'policyHash', 'policySnapshot', issues);
    checkString(policy, 'organizationId', 'policySnapshot', issues);
    if (policy.program !== run.program) issues.push('policySnapshot.program must match run.program');
    if (!Array.isArray(policy.analyzers)) issues.push('policySnapshot.analyzers must be an array');
    const packetLimits = record(policy.packetLimits);
    const budgets = record(policy.budgets);
    if (!packetLimits) issues.push('policySnapshot.packetLimits must be an object');
    if (!budgets) issues.push('policySnapshot.budgets must be an object');
  }

  const source = record(run.sourceSnapshot);
  if (!source) {
    issues.push('sourceSnapshot must be an object');
  } else {
    checkString(source, 'id', 'sourceSnapshot', issues);
    if (!oneOf(source.status, SOURCE_SNAPSHOT_STATUSES)) issues.push('sourceSnapshot.status is invalid');
    const sourceRevision = record(source.revision);
    if (!sourceRevision) {
      issues.push('sourceSnapshot.revision must be an object');
    } else if (revision && sourceRevision.headSha !== revision.headSha) {
      issues.push('sourceSnapshot.revision.headSha must match run.revision.headSha');
    }
    for (const key of ['fileCount', 'textFileCount', 'indexedFileCount', 'unsupportedFileCount']) {
      if (!nonNegativeInteger(source[key])) issues.push(`sourceSnapshot.${key} must be a non-negative integer`);
    }
  }

  checkCoverage(run.coverage, issues);

  if (!Array.isArray(run.stages)) {
    issues.push('stages must be an array');
  } else {
    run.stages.forEach((raw, index) => {
      const stage = record(raw);
      if (!stage) {
        issues.push(`stages[${index}] must be an object`);
        return;
      }
      checkString(stage, 'id', `stages[${index}]`, issues);
      if (!oneOf(stage.stage, ASSURANCE_STAGE_NAMES)) issues.push(`stages[${index}].stage is invalid`);
      if (!oneOf(stage.status, ASSURANCE_STAGE_STATUSES)) issues.push(`stages[${index}].status is invalid`);
      if (!Number.isInteger(stage.attempt) || Number(stage.attempt) < 1) {
        issues.push(`stages[${index}].attempt must be a positive integer`);
      }
    });
  }

  if (!Array.isArray(run.findings)) {
    issues.push('findings must be an array');
  } else {
    run.findings.forEach((raw, index) => {
      const finding = record(raw);
      if (!finding) {
        issues.push(`findings[${index}] must be an object`);
        return;
      }
      checkString(finding, 'id', `findings[${index}]`, issues);
      checkString(finding, 'fingerprint', `findings[${index}]`, issues);
      if (!oneOf(finding.state, ASSURANCE_FINDING_STATES)) issues.push(`findings[${index}].state is invalid`);
      if (!oneOf(finding.severity, ASSURANCE_SEVERITIES)) issues.push(`findings[${index}].severity is invalid`);
    });
  }

  if (run.status === 'superseded' && !nonEmpty(run.supersededByRunId)) {
    issues.push('superseded runs require supersededByRunId');
  }
  if (run.status === 'stale' && !nonEmpty(run.staleReason)) {
    issues.push('stale runs require staleReason');
  }
  if (
    run.status === 'completed'
    && (source?.status !== 'ready' || record(run.coverage)?.status !== 'complete')
  ) {
    issues.push('completed runs require a ready source snapshot and complete coverage');
  }

  return { ok: issues.length === 0, issues };
}

export function isRepositoryAssuranceRun(value: unknown): value is RepositoryAssuranceRun {
  return validateRepositoryAssuranceRun(value).ok;
}
