/**
 * Pure presentation model for durable repository assurance.
 *
 * UI surfaces consume this model so lifecycle authority, partial coverage, and
 * verifier dispositions are rendered consistently without redefining contracts.
 */
import type {
  AssuranceFinding,
  AssuranceRunStatus,
  AssuranceStageStatus,
  ReviewAssuranceDto,
} from "@kinqs/brainrouter-types";

export type AssuranceTone = "neutral" | "ok" | "warn" | "danger" | "info";

export interface AssuranceFindingPresentation {
  id: string;
  title: string;
  severity: string;
  state: string;
  tone: AssuranceTone;
  confidence: string;
  location: string;
  mechanism: string;
  evidence: string[];
  verifier: string | null;
  limitations: string[];
}

export interface ReviewAssurancePresentation {
  status: string;
  runStatus: string;
  statusTone: AssuranceTone;
  authorityNotice: string;
  publication?: {
    status: string;
    conclusion: string;
    reason: string;
  };
  program: string;
  revision: string;
  coverage: {
    status: string;
    tone: AssuranceTone;
    files: string;
    changedFiles: string;
    limitations: string[];
  };
  stages: Array<{
    id: string;
    name: string;
    status: string;
    tone: AssuranceTone;
    detail: string;
  }>;
  findings: AssuranceFindingPresentation[];
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function runTone(status: AssuranceRunStatus): AssuranceTone {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "canceled") return "danger";
  if (status === "partial" || status === "stale" || status === "superseded") return "warn";
  return "info";
}

function stageTone(status: AssuranceStageStatus): AssuranceTone {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "canceled") return "danger";
  if (status === "partial") return "warn";
  return status === "running" ? "info" : "neutral";
}

function findingTone(finding: AssuranceFinding): AssuranceTone {
  if (finding.state === "verified" || finding.state === "validated") return "ok";
  if (finding.state === "disputed") return "danger";
  if (finding.state === "insufficient_evidence") return "warn";
  return "info";
}

function authorityNotice(assurance: ReviewAssuranceDto): string {
  const { run } = assurance;
  if (run.status === "stale") {
    return run.staleReason || "This result no longer matches the current repository revision.";
  }
  if (run.status === "superseded") {
    return run.supersededByRunId
      ? `A newer assurance run replaced this result (${run.supersededByRunId}).`
      : "A newer assurance run replaced this result.";
  }
  if (run.status === "partial") {
    return "Coverage or required evidence is incomplete; this run cannot represent a clean result.";
  }
  if (run.status === "completed") {
    return "This result applies to the exact revision and policy shown below.";
  }
  return `This run is ${label(run.status)} and is not a completed assurance result.`;
}

function presentFinding(finding: AssuranceFinding): AssuranceFindingPresentation {
  const line = finding.location.line ? `:${finding.location.line}` : "";
  return {
    id: finding.id,
    title: finding.title,
    severity: label(finding.severity),
    state: label(finding.state),
    tone: findingTone(finding),
    confidence: `${Math.round(finding.confidence * 100)}%`,
    location: `${finding.location.path}${line}`,
    mechanism: finding.mechanism,
    evidence: finding.evidence.map((evidence) => evidence.summary),
    verifier: finding.verifier
      ? `${label(finding.verifier.state)} · ${finding.verifier.rationale}`
      : null,
    limitations: finding.coverageLimitations.map((limitation) => limitation.summary),
  };
}

export function buildReviewAssurancePresentation(
  assurance: ReviewAssuranceDto,
): ReviewAssurancePresentation {
  const { run } = assurance;
  const publication = assurance.publication;
  const coverageTone: AssuranceTone = run.coverage.status === "complete"
    ? "ok"
    : run.coverage.status === "partial"
      ? "warn"
      : "danger";
  return {
    status: publication?.label ?? label(run.status),
    runStatus: label(run.status),
    statusTone: publication
      ? publication.conclusion === "success"
        ? "ok"
        : publication.conclusion === "failure"
          ? "danger"
          : "warn"
      : runTone(run.status),
    authorityNotice: publication?.reason ?? authorityNotice(assurance),
    ...(publication ? {
      publication: {
        status: publication.status,
        conclusion: publication.conclusion,
        reason: publication.reason,
      },
    } : {}),
    program: label(run.program),
    revision: run.revision.headSha,
    coverage: {
      status: label(run.coverage.status),
      tone: coverageTone,
      files: `${run.coverage.filesAnalyzed}/${run.coverage.filesEligible} eligible files`,
      changedFiles: `${run.coverage.changedFilesAnalyzed}/${run.coverage.changedFilesTotal} changed files`,
      limitations: run.coverage.limitations.map((limitation) => limitation.summary),
    },
    stages: run.stages.map((stage) => ({
      id: stage.id,
      name: label(stage.stage),
      status: label(stage.status),
      tone: stageTone(stage.status),
      detail: stage.errorCode
        ? `${stage.errorCode} · attempt ${stage.attempt}`
        : `attempt ${stage.attempt}`,
    })),
    findings: assurance.findings.map(presentFinding),
  };
}
