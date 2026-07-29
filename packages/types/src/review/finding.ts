import type { AssuranceCoverageLimitation } from './coverage.js';
import type {
  AssuranceEvidenceRef,
  AssuranceProvenance,
  AssuranceSourceLocation,
} from './evidence.js';
import type { RepositoryAssuranceProgram } from './program.js';

export const ASSURANCE_FINDING_STATES = [
  'candidate',
  'hotspot',
  'verified',
  'disputed',
  'insufficient_evidence',
  'validated',
] as const;

export type AssuranceFindingState = (typeof ASSURANCE_FINDING_STATES)[number];

export const ASSURANCE_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;

export type AssuranceSeverity = (typeof ASSURANCE_SEVERITIES)[number];

export interface AssuranceVerifierDisposition {
  state: Exclude<AssuranceFindingState, 'candidate' | 'hotspot'>;
  verifierId: string;
  rationale: string;
  evidenceRefs: string[];
  decidedAt: string;
}

/** Stable lineage record shared by all assurance programs. */
export interface AssuranceFinding {
  id: string;
  fingerprint: string;
  program: RepositoryAssuranceProgram;
  revisionSha: string;
  state: AssuranceFindingState;
  severity: AssuranceSeverity;
  confidence: number;
  title: string;
  mechanism: string;
  location: AssuranceSourceLocation;
  evidence: AssuranceEvidenceRef[];
  provenance: AssuranceProvenance[];
  coverageLimitations: AssuranceCoverageLimitation[];
  verifier?: AssuranceVerifierDisposition;
  cwe?: string;
  cve?: string;
  remediation?: string;
  createdAt: string;
  updatedAt: string;
}

/** Bounded reference retained on a run; the durable finding is stored separately. */
export interface AssuranceFindingRef {
  id: string;
  fingerprint: string;
  state: AssuranceFindingState;
  severity: AssuranceSeverity;
}
