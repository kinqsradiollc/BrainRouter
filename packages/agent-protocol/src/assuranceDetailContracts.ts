import type {
  AssuranceComponentStatusView,
  AssuranceProgramView,
  AssuranceRunEventView,
} from './assurance.js';

export const ASSURANCE_FINDING_STATE_VIEWS = [
  'candidate',
  'hotspot',
  'verified',
  'disputed',
  'insufficient_evidence',
  'validated',
] as const;
export type AssuranceFindingStateView = (typeof ASSURANCE_FINDING_STATE_VIEWS)[number];

export const ASSURANCE_SEVERITY_VIEWS = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;
export type AssuranceSeverityView = (typeof ASSURANCE_SEVERITY_VIEWS)[number];

export const ASSURANCE_EVIDENCE_KIND_VIEWS = [
  'source',
  'call_path',
  'reference_path',
  'configuration',
  'dependency',
  'secret_match',
  'test',
  'diagnostic',
  'runtime_observation',
  'authorization',
  'cleanup',
] as const;
export type AssuranceEvidenceKindView = (typeof ASSURANCE_EVIDENCE_KIND_VIEWS)[number];

export const ASSURANCE_PUBLICATION_STATUS_VIEWS = [
  'running',
  'clean',
  'advisory',
  'blocked',
  'partial',
  'failed',
  'canceled',
  'superseded',
  'stale',
] as const;
export type AssurancePublicationStatusView = (typeof ASSURANCE_PUBLICATION_STATUS_VIEWS)[number];

export const ASSURANCE_PUBLICATION_CONCLUSION_VIEWS = [
  'success',
  'neutral',
  'failure',
] as const;
export type AssurancePublicationConclusionView = (typeof ASSURANCE_PUBLICATION_CONCLUSION_VIEWS)[number];

export interface AssurancePublicationView {
  schemaVersion: 1;
  status: AssurancePublicationStatusView;
  label: string;
  conclusion: AssurancePublicationConclusionView;
  blocked: boolean;
  cleanEligible: boolean;
  reason: string;
  blockingFindingIds: string[];
}

export interface AssuranceSourceLocationView {
  path: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  logicalPath?: string;
}

export interface AssuranceCoverageLimitationView {
  id: string;
  component: string;
  state: Exclude<AssuranceComponentStatusView, 'covered'>;
  reasonCode: string;
  summary: string;
  affectedPaths?: string[];
  affectedLanguages?: string[];
}

export interface AssuranceEvidenceView {
  id: string;
  kind: AssuranceEvidenceKindView;
  summary: string;
  revisionSha: string;
  location?: AssuranceSourceLocationView;
  artifactRef?: string;
  analyzerId?: string;
  modelId?: string;
  createdAt: string;
}

export interface AssuranceProvenanceView {
  producerKind: 'deterministic_analyzer' | 'model' | 'human' | 'runtime_probe';
  producerId: string;
  version?: string;
  policyHash: string;
  createdAt: string;
}

export interface AssuranceVerifierDispositionView {
  state: Exclude<AssuranceFindingStateView, 'candidate' | 'hotspot'>;
  verifierId: string;
  rationale: string;
  evidenceRefs: string[];
  decidedAt: string;
}

export interface AssuranceFindingView {
  id: string;
  fingerprint: string;
  program: AssuranceProgramView;
  revisionSha: string;
  state: AssuranceFindingStateView;
  severity: AssuranceSeverityView;
  confidence: number;
  title: string;
  mechanism: string;
  location: AssuranceSourceLocationView;
  evidence: AssuranceEvidenceView[];
  provenance: AssuranceProvenanceView[];
  coverageLimitations: AssuranceCoverageLimitationView[];
  verifier?: AssuranceVerifierDispositionView;
  cwe?: string;
  cve?: string;
  remediation?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSummaryView {
  id: string;
  lens: 'security' | 'code' | 'pentest';
  status: string;
  repo: string | null;
  prNumber: number | null;
  forge?: 'github' | 'gitlab';
  findings: number | null;
  blocking: number | null;
  skipped: string | null;
  error: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface ReviewAssuranceDetailView {
  review: ReviewSummaryView;
  assurance: {
    run: AssuranceRunEventView;
    findings: AssuranceFindingView[];
    /** Exact forge publication projection. Absent on legacy review records. */
    publication?: AssurancePublicationView;
  } | null;
  canRun: boolean;
}
