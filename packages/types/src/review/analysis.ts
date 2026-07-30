import type { AssuranceCoverageLimitation } from './coverage.js';
import type { AssuranceEvidenceRef, AssuranceSourceLocation } from './evidence.js';
import type { RepositoryAssuranceProgram, RepositoryRef, RepositoryRevision } from './program.js';
import type { SourceSnapshot } from './source.js';

export const ASSURANCE_SYMBOL_KINDS = [
  'module',
  'function',
  'method',
  'class',
  'interface',
  'type',
  'variable',
  'route',
] as const;

export type AssuranceSymbolKind = (typeof ASSURANCE_SYMBOL_KINDS)[number];

export interface AssuranceCodeSymbol {
  id: string;
  name: string;
  kind: AssuranceSymbolKind;
  language: string;
  location: AssuranceSourceLocation;
  exported: boolean;
}

export const ASSURANCE_CODE_RELATIONSHIPS = [
  'calls',
  'references',
  'imports',
  'extends',
  'implements',
  'configures',
  'tests',
] as const;

export type AssuranceCodeRelationship = (typeof ASSURANCE_CODE_RELATIONSHIPS)[number];

export interface AssuranceCodeRelationshipEdge {
  id: string;
  relationship: AssuranceCodeRelationship;
  fromSymbolId: string;
  toSymbolId: string;
  location?: AssuranceSourceLocation;
}

/**
 * Secret-free receipt for a parser-backed index retained by a host adapter.
 *
 * The graph itself remains behind `indexRef`; shared contracts carry only
 * bounded counters and coverage so consumers do not duplicate an index.
 */
export interface AssuranceCodeIndexReceipt {
  id: string;
  revisionSha: string;
  indexRef: string;
  status: 'ready' | 'partial' | 'failed';
  analyzerId: string;
  analyzerVersion: string;
  supportedLanguages: string[];
  filesEligible: number;
  filesIndexed: number;
  symbolsIndexed: number;
  relationshipsIndexed: number;
  limitationIds: string[];
  createdAt: string;
  completedAt?: string;
  errorCode?: string;
}

export interface AssuranceCodeIndexResult {
  receipt: AssuranceCodeIndexReceipt;
  limitations: AssuranceCoverageLimitation[];
}

export const ASSURANCE_IMPACT_RELATIONSHIPS = [
  'changed',
  'caller',
  'callee',
  'reference',
  'configuration',
  'dependency',
  'test',
  'source_to_sink',
] as const;

export type AssuranceImpactRelationship = (typeof ASSURANCE_IMPACT_RELATIONSHIPS)[number];

export interface AssuranceImpactContext {
  relationship: AssuranceImpactRelationship;
  distance: number;
  evidence: AssuranceEvidenceRef;
}

export interface AssuranceSourceToSinkPath {
  id: string;
  mechanism: 'call_path' | 'data_flow' | 'configuration_flow';
  source: AssuranceSourceLocation;
  sink: AssuranceSourceLocation;
  evidenceRefs: string[];
}

/**
 * One bounded, exact-revision packet suitable for deterministic verification
 * or a specialist model. Source bodies remain in retained artifacts.
 */
export interface AssuranceImpactPacket {
  id: string;
  revisionSha: string;
  program: RepositoryAssuranceProgram;
  changed: AssuranceSourceLocation[];
  context: AssuranceImpactContext[];
  sourceToSinkPaths: AssuranceSourceToSinkPath[];
  artifactRefs: string[];
  byteCount: number;
  truncated: boolean;
  limitationIds: string[];
}

export interface AssuranceImpactPacketAssembly {
  revisionSha: string;
  indexRef: string;
  packets: AssuranceImpactPacket[];
  limitations: AssuranceCoverageLimitation[];
  assembledAt: string;
}

export interface PrepareAssuranceSourceInput {
  runId: string;
  repository: RepositoryRef;
  revision: RepositoryRevision;
}

export interface PrepareAssuranceSourceResult {
  source: SourceSnapshot;
  limitations: AssuranceCoverageLimitation[];
}

export interface UpdateAssuranceIndexInput {
  runId: string;
  repository: RepositoryRef;
  revision: RepositoryRevision;
  checkoutRef: string;
}

export interface AssembleAssuranceImpactPacketsInput {
  runId: string;
  repository: RepositoryRef;
  revision: RepositoryRevision;
  program: RepositoryAssuranceProgram;
  checkoutRef: string;
  indexRef: string;
  changed: AssuranceSourceLocation[];
  redactionPolicyId: string;
  limits: {
    maxPackets: number;
    maxPacketBytes: number;
    maxFilesPerPacket: number;
  };
}
