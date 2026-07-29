/** An exact source anchor. At least one of line, symbol, or logicalPath is expected. */
export interface AssuranceSourceLocation {
  path: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  logicalPath?: string;
}

export const ASSURANCE_EVIDENCE_KINDS = [
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

export type AssuranceEvidenceKind = (typeof ASSURANCE_EVIDENCE_KINDS)[number];

/**
 * A bounded reference to evidence retained by an owning adapter.
 *
 * The shared contract carries identifiers and safe summaries, never checkout
 * credentials, provider prompts, secret values, or arbitrary command output.
 */
export interface AssuranceEvidenceRef {
  id: string;
  kind: AssuranceEvidenceKind;
  summary: string;
  revisionSha: string;
  location?: AssuranceSourceLocation;
  artifactRef?: string;
  analyzerId?: string;
  modelId?: string;
  createdAt: string;
}

export interface AssuranceProvenance {
  producerKind: 'deterministic_analyzer' | 'model' | 'human' | 'runtime_probe';
  producerId: string;
  version?: string;
  policyHash: string;
  createdAt: string;
}
