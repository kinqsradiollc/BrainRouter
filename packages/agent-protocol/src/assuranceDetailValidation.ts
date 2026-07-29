import {
  ASSURANCE_COMPONENT_STATUS_VIEWS,
  ASSURANCE_PROGRAM_VIEWS,
} from './assurance.js';
import {
  ASSURANCE_EVIDENCE_KIND_VIEWS,
  ASSURANCE_FINDING_STATE_VIEWS,
  ASSURANCE_SEVERITY_VIEWS,
  type AssuranceCoverageLimitationView,
  type AssuranceEvidenceView,
  type AssuranceFindingView,
  type AssuranceProvenanceView,
  type AssuranceSourceLocationView,
  type AssuranceVerifierDispositionView,
} from './assuranceDetailContracts.js';

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function optionalNonEmpty(value: unknown): value is string | undefined {
  return value === undefined || nonEmpty(value);
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(nonEmpty));
}

export function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || nonNegativeInteger(value);
}

function projectLocation(value: unknown): AssuranceSourceLocationView | null {
  const location = record(value);
  if (
    !location
    || !nonEmpty(location.path)
    || (location.line !== undefined && !positiveInteger(location.line))
    || (location.endLine !== undefined && !positiveInteger(location.endLine))
    || (typeof location.line === 'number'
      && typeof location.endLine === 'number'
      && location.endLine < location.line)
    || !optionalNonEmpty(location.symbol)
    || !optionalNonEmpty(location.logicalPath)
  ) return null;
  return {
    path: location.path,
    ...(location.line === undefined ? {} : { line: location.line as number }),
    ...(location.endLine === undefined ? {} : { endLine: location.endLine as number }),
    ...(location.symbol === undefined ? {} : { symbol: location.symbol }),
    ...(location.logicalPath === undefined ? {} : { logicalPath: location.logicalPath }),
  };
}

export function projectLimitation(value: unknown): AssuranceCoverageLimitationView | null {
  const limitation = record(value);
  if (
    !limitation
    || !nonEmpty(limitation.id)
    || !nonEmpty(limitation.component)
    || !oneOf(limitation.state, ASSURANCE_COMPONENT_STATUS_VIEWS)
    || limitation.state === 'covered'
    || !nonEmpty(limitation.reasonCode)
    || !nonEmpty(limitation.summary)
    || !optionalStringArray(limitation.affectedPaths)
    || !optionalStringArray(limitation.affectedLanguages)
  ) return null;
  return {
    id: limitation.id,
    component: limitation.component,
    state: limitation.state,
    reasonCode: limitation.reasonCode,
    summary: limitation.summary,
    ...(limitation.affectedPaths === undefined ? {} : { affectedPaths: limitation.affectedPaths }),
    ...(limitation.affectedLanguages === undefined ? {} : { affectedLanguages: limitation.affectedLanguages }),
  };
}

function projectEvidence(value: unknown): AssuranceEvidenceView | null {
  const evidence = record(value);
  if (
    !evidence
    || !nonEmpty(evidence.id)
    || !oneOf(evidence.kind, ASSURANCE_EVIDENCE_KIND_VIEWS)
    || !nonEmpty(evidence.summary)
    || !nonEmpty(evidence.revisionSha)
    || !optionalNonEmpty(evidence.artifactRef)
    || !optionalNonEmpty(evidence.analyzerId)
    || !optionalNonEmpty(evidence.modelId)
    || !nonEmpty(evidence.createdAt)
  ) return null;
  const location = evidence.location === undefined ? undefined : projectLocation(evidence.location);
  if (location === null) return null;
  return {
    id: evidence.id,
    kind: evidence.kind,
    summary: evidence.summary,
    revisionSha: evidence.revisionSha,
    ...(location === undefined ? {} : { location }),
    ...(evidence.artifactRef === undefined ? {} : { artifactRef: evidence.artifactRef }),
    ...(evidence.analyzerId === undefined ? {} : { analyzerId: evidence.analyzerId }),
    ...(evidence.modelId === undefined ? {} : { modelId: evidence.modelId }),
    createdAt: evidence.createdAt,
  };
}

function projectProvenance(value: unknown): AssuranceProvenanceView | null {
  const provenance = record(value);
  if (
    !provenance
    || !oneOf(provenance.producerKind, ['deterministic_analyzer', 'model', 'human', 'runtime_probe'])
    || !nonEmpty(provenance.producerId)
    || !optionalNonEmpty(provenance.version)
    || !nonEmpty(provenance.policyHash)
    || !nonEmpty(provenance.createdAt)
  ) return null;
  return {
    producerKind: provenance.producerKind,
    producerId: provenance.producerId,
    ...(provenance.version === undefined ? {} : { version: provenance.version }),
    policyHash: provenance.policyHash,
    createdAt: provenance.createdAt,
  };
}

function projectVerifier(value: unknown): AssuranceVerifierDispositionView | null {
  const verifier = record(value);
  if (
    !verifier
    || !oneOf(verifier.state, ASSURANCE_FINDING_STATE_VIEWS)
    || verifier.state === 'candidate'
    || verifier.state === 'hotspot'
    || !nonEmpty(verifier.verifierId)
    || !nonEmpty(verifier.rationale)
    || !Array.isArray(verifier.evidenceRefs)
    || !verifier.evidenceRefs.every(nonEmpty)
    || !nonEmpty(verifier.decidedAt)
  ) return null;
  return {
    state: verifier.state,
    verifierId: verifier.verifierId,
    rationale: verifier.rationale,
    evidenceRefs: verifier.evidenceRefs,
    decidedAt: verifier.decidedAt,
  };
}

export function projectFinding(value: unknown): AssuranceFindingView | null {
  const finding = record(value);
  if (
    !finding
    || !nonEmpty(finding.id)
    || !nonEmpty(finding.fingerprint)
    || !oneOf(finding.program, ASSURANCE_PROGRAM_VIEWS)
    || !nonEmpty(finding.revisionSha)
    || !oneOf(finding.state, ASSURANCE_FINDING_STATE_VIEWS)
    || !oneOf(finding.severity, ASSURANCE_SEVERITY_VIEWS)
    || typeof finding.confidence !== 'number'
    || !Number.isFinite(finding.confidence)
    || finding.confidence < 0
    || finding.confidence > 1
    || !nonEmpty(finding.title)
    || !nonEmpty(finding.mechanism)
    || !Array.isArray(finding.evidence)
    || !Array.isArray(finding.provenance)
    || !Array.isArray(finding.coverageLimitations)
    || !optionalNonEmpty(finding.cwe)
    || !optionalNonEmpty(finding.cve)
    || !optionalNonEmpty(finding.remediation)
    || !nonEmpty(finding.createdAt)
    || !nonEmpty(finding.updatedAt)
  ) return null;
  const location = projectLocation(finding.location);
  const evidence = finding.evidence.map(projectEvidence);
  const provenance = finding.provenance.map(projectProvenance);
  const limitations = finding.coverageLimitations.map(projectLimitation);
  const verifier = finding.verifier === undefined ? undefined : projectVerifier(finding.verifier);
  if (
    !location
    || evidence.some((item) => item === null)
    || provenance.some((item) => item === null)
    || limitations.some((item) => item === null)
    || verifier === null
  ) return null;
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    program: finding.program,
    revisionSha: finding.revisionSha,
    state: finding.state,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    mechanism: finding.mechanism,
    location,
    evidence: evidence as AssuranceEvidenceView[],
    provenance: provenance as AssuranceProvenanceView[],
    coverageLimitations: limitations as AssuranceCoverageLimitationView[],
    ...(verifier === undefined ? {} : { verifier }),
    ...(finding.cwe === undefined ? {} : { cwe: finding.cwe }),
    ...(finding.cve === undefined ? {} : { cve: finding.cve }),
    ...(finding.remediation === undefined ? {} : { remediation: finding.remediation }),
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
  };
}
