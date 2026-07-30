import type { ReviewAssuranceDetailView } from '@kinqs/brainrouter-agent-protocol';

export interface DesktopAssurancePresentation {
  available: boolean;
  runId?: string;
  program?: string;
  runStatus?: string;
  status?: string;
  publication?: {
    status: string;
    label: string;
    conclusion: string;
    reason: string;
  };
  revision?: string;
  baseRevision?: string;
  policy?: string;
  source?: {
    status: string;
    indexed: string;
  };
  coverage?: {
    status: string;
    files: string;
    changedFiles: string;
    limitations: Array<{ state: string; component: string; summary: string }>;
  };
  stages: Array<{
    id: string;
    name: string;
    status: string;
    attempt: number;
    errorCode?: string;
  }>;
  findings: Array<{
    id: string;
    severity: string;
    state: string;
    title: string;
    location: string;
    confidence: number;
    mechanism: string;
    evidence: Array<{ id: string; kind: string; summary: string }>;
    verifier?: { id: string; state: string; rationale: string };
  }>;
  staleReason?: string;
  supersededBy?: string;
}

/** Host-specific presentation only; all authority values come from the protocol. */
export function buildDesktopAssurancePresentation(
  detail: ReviewAssuranceDetailView,
): DesktopAssurancePresentation {
  if (!detail.assurance) return { available: false, stages: [], findings: [] };
  const { run, findings } = detail.assurance;
  return {
    available: true,
    runId: run.id,
    program: run.program,
    runStatus: run.status,
    status: detail.assurance.publication?.label ?? run.status,
    ...(detail.assurance.publication ? {
      publication: {
        status: detail.assurance.publication.status,
        label: detail.assurance.publication.label,
        conclusion: detail.assurance.publication.conclusion,
        reason: detail.assurance.publication.reason,
      },
    } : {}),
    revision: run.revision.headSha,
    ...(run.revision.baseSha ? { baseRevision: run.revision.baseSha } : {}),
    policy: `${run.policy.id} · ${run.policy.hash}`,
    source: {
      status: run.source.status,
      indexed: `${run.source.indexedFileCount}/${run.source.textFileCount} text files indexed`,
    },
    coverage: {
      status: run.coverage.status,
      files: `${run.coverage.filesAnalyzed}/${run.coverage.filesEligible} eligible files`,
      changedFiles: `${run.coverage.changedFilesAnalyzed}/${run.coverage.changedFilesTotal} changed files`,
      limitations: run.coverage.limitations.map((limitation) => ({
        state: limitation.state,
        component: limitation.component,
        summary: limitation.summary,
      })),
    },
    stages: run.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      status: stage.status,
      attempt: stage.attempt,
      ...(stage.errorCode ? { errorCode: stage.errorCode } : {}),
    })),
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      state: finding.state,
      title: finding.title,
      location: `${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ''}${finding.location.symbol ? ` · ${finding.location.symbol}` : ''}`,
      confidence: finding.confidence,
      mechanism: finding.mechanism,
      evidence: finding.evidence.map((evidence) => ({
        id: evidence.id,
        kind: evidence.kind,
        summary: evidence.summary,
      })),
      ...(finding.verifier ? {
        verifier: {
          id: finding.verifier.verifierId,
          state: finding.verifier.state,
          rationale: finding.verifier.rationale,
        },
      } : {}),
    })),
    ...(run.staleReason ? { staleReason: run.staleReason } : {}),
    ...(run.supersededByRunId ? { supersededBy: run.supersededByRunId } : {}),
  };
}
