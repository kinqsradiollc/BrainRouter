/**
 * Coverage- and evidence-aware repository-assurance gate policy.
 *
 * This policy never upgrades a candidate or a partial/stale run into a clean or
 * blocking conclusion. Code review remains advisory unless a future explicit
 * policy changes that program contract.
 */

import type {
  AssuranceCoverage,
  AssuranceFinding,
  AssurancePublicationProjection,
  AssurancePublicationStatus,
  AssuranceSeverity,
  RepositoryAssuranceRun,
} from '@kinqs/brainrouter-types/review';
import { ASSURANCE_PUBLICATION_STATUSES } from '@kinqs/brainrouter-types/review';

export type AssuranceGateStatus = AssurancePublicationStatus;

export interface AssuranceGateDecision {
  status: AssuranceGateStatus;
  blocked: boolean;
  cleanEligible: boolean;
  reason: string;
  blockingFindingIds: string[];
}

const PUBLICATION_STATUS_SET = new Set<string>(ASSURANCE_PUBLICATION_STATUSES);

const PUBLICATION_LABELS: Record<AssurancePublicationStatus, string> = {
  running: 'running',
  clean: 'clean',
  advisory: 'advisory',
  blocked: 'blocked',
  partial: 'partial',
  failed: 'failed',
  canceled: 'canceled',
  superseded: 'superseded',
  stale: 'stale',
};

/**
 * Validate a persisted or adapter-provided gate before it regains publication
 * authority. In particular, only a clean gate may claim clean eligibility.
 */
export function parseAssuranceGateDecision(value: unknown): AssuranceGateDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const gate = value as Record<string, unknown>;
  if (
    typeof gate.status !== 'string'
    || !PUBLICATION_STATUS_SET.has(gate.status)
    || typeof gate.blocked !== 'boolean'
    || typeof gate.cleanEligible !== 'boolean'
    || typeof gate.reason !== 'string'
    || gate.reason.trim().length === 0
    || !Array.isArray(gate.blockingFindingIds)
    || !gate.blockingFindingIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) return null;

  const status = gate.status as AssuranceGateStatus;
  if (gate.blocked && gate.cleanEligible) return null;
  if (gate.cleanEligible && status !== 'clean') return null;
  if (status === 'clean' && (!gate.cleanEligible || gate.blocked)) return null;
  if (status === 'blocked' && !gate.blocked) return null;

  return {
    status,
    blocked: gate.blocked,
    cleanEligible: gate.cleanEligible,
    reason: gate.reason,
    blockingFindingIds: [...gate.blockingFindingIds] as string[],
  };
}

/** Produce the single publication record consumed by every host. */
export function projectAssurancePublication(
  gate: AssuranceGateDecision,
): AssurancePublicationProjection {
  return {
    schemaVersion: 1,
    status: gate.status,
    label: PUBLICATION_LABELS[gate.status],
    conclusion: gate.blocked
      ? 'failure'
      : gate.cleanEligible
        ? 'success'
        : 'neutral',
    blocked: gate.blocked,
    cleanEligible: gate.cleanEligible,
    reason: gate.reason,
    blockingFindingIds: [...gate.blockingFindingIds],
  };
}

const SEVERITY_RANK: Record<AssuranceSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function coverageSupportsCleanConclusion(coverage: AssuranceCoverage): boolean {
  return coverage.status === 'complete'
    && coverage.limitations.length === 0
    && coverage.filesEligible === coverage.filesAnalyzed
    && coverage.changedFilesTotal === coverage.changedFilesAnalyzed
    && coverage.analyzers.every((analyzer) => analyzer.state === 'covered');
}

export function findingHasBlockingEvidence(finding: AssuranceFinding): boolean {
  return (finding.state === 'verified' || finding.state === 'validated')
    && finding.evidence.length > 0
    && finding.provenance.length > 0
    && finding.verifier !== undefined
    && finding.verifier.evidenceRefs.length > 0
    && finding.verifier.evidenceRefs.every((id) => finding.evidence.some((evidence) => evidence.id === id));
}

export function calculateAssuranceGate(input: {
  run: RepositoryAssuranceRun;
  findings: AssuranceFinding[];
  currentHeadSha: string;
  minimumSeverity?: AssuranceSeverity;
}): AssuranceGateDecision {
  const { run, findings, currentHeadSha } = input;
  const required = run.policySnapshot.blockingEnabled && run.program !== 'code_review';
  const nonClean = (
    status: AssuranceGateStatus,
    reason: string,
    blocked = required,
  ): AssuranceGateDecision => ({
    status,
    blocked,
    cleanEligible: false,
    reason,
    blockingFindingIds: [],
  });

  if (run.revision.headSha !== currentHeadSha) {
    return nonClean('stale', 'The assurance run does not match the current repository head.');
  }
  if (run.status === 'queued' || run.status === 'running') {
    return nonClean('running', 'Repository assurance is still running.');
  }
  if (run.status === 'partial') {
    return nonClean('partial', 'Repository assurance completed with partial evidence.');
  }
  if (run.status === 'failed') return nonClean('failed', 'Repository assurance failed.');
  if (run.status === 'canceled') return nonClean('canceled', 'Repository assurance was canceled.');
  if (run.status === 'superseded') return nonClean('superseded', 'Repository assurance was superseded.');
  if (run.status === 'stale') return nonClean('stale', 'Repository assurance is stale.');
  if (!coverageSupportsCleanConclusion(run.coverage)) {
    return nonClean('partial', 'Coverage is incomplete or contains analyzer limitations.');
  }

  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const missingFinding = run.findings.find((reference) => !findingsById.has(reference.id));
  if (missingFinding) {
    return nonClean('partial', `Finding ${missingFinding.id} is referenced but its evidence record is unavailable.`);
  }
  const mismatchedFinding = run.findings.find((reference) => {
    const finding = findingsById.get(reference.id);
    return finding
      && (finding.fingerprint !== reference.fingerprint
        || finding.state !== reference.state
        || finding.severity !== reference.severity);
  });
  if (mismatchedFinding) {
    return nonClean('partial', `Finding ${mismatchedFinding.id} does not match its run reference.`);
  }

  const floor = SEVERITY_RANK[input.minimumSeverity ?? 'high'];
  const runFindings = run.findings
    .map((reference) => findingsById.get(reference.id))
    .filter((finding): finding is AssuranceFinding => finding !== undefined);
  const relevant = runFindings.filter((finding) =>
    finding.program === run.program
    && finding.revisionSha === run.revision.headSha);
  const blocking = relevant.filter((finding) =>
    finding.program === run.program
    && finding.revisionSha === run.revision.headSha
    && SEVERITY_RANK[finding.severity] >= floor
    && findingHasBlockingEvidence(finding));
  const unresolved = relevant.filter((finding) =>
    finding.state === 'candidate'
    || finding.state === 'hotspot'
    || finding.state === 'insufficient_evidence'
    || ((finding.state === 'verified' || finding.state === 'validated')
      && !findingHasBlockingEvidence(finding)));

  if (run.program === 'code_review') {
    const advisoryCount = blocking.length + unresolved.length;
    return {
      status: advisoryCount > 0 ? 'advisory' : 'clean',
      blocked: false,
      cleanEligible: advisoryCount === 0,
      reason: advisoryCount > 0
        ? `${advisoryCount} code-review finding(s) remain advisory or unresolved.`
        : 'Code review completed with full coverage and no supported high-severity findings.',
      blockingFindingIds: [],
    };
  }
  if (blocking.length > 0 && required) {
    return {
      status: 'blocked',
      blocked: true,
      cleanEligible: false,
      reason: `${blocking.length} independently supported finding(s) meet the blocking policy.`,
      blockingFindingIds: blocking.map((finding) => finding.id),
    };
  }
  if (unresolved.length > 0) {
    return {
      status: 'advisory',
      blocked: false,
      cleanEligible: false,
      reason: `${unresolved.length} candidate or insufficiently supported finding(s) require disposition.`,
      blockingFindingIds: [],
    };
  }
  return {
    status: blocking.length > 0 ? 'advisory' : 'clean',
    blocked: false,
    cleanEligible: blocking.length === 0,
    reason: blocking.length > 0
      ? 'Supported findings are advisory because blocking is disabled.'
      : 'Full coverage and verifier-supported finding policy permit a clean conclusion.',
    blockingFindingIds: [],
  };
}
