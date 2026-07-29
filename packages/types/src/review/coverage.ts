export const ASSURANCE_COVERAGE_STATES = [
  'covered',
  'partial',
  'disabled',
  'unsupported',
  'unavailable',
  'failed',
] as const;

export type AssuranceCoverageState = (typeof ASSURANCE_COVERAGE_STATES)[number];

export interface AssuranceCoverageLimitation {
  id: string;
  component: string;
  state: Exclude<AssuranceCoverageState, 'covered'>;
  reasonCode: string;
  summary: string;
  affectedPaths?: string[];
  affectedLanguages?: string[];
}

/** One analyzer/indexer contribution to the aggregate coverage statement. */
export interface AssuranceAnalyzerCoverage {
  analyzerId: string;
  analyzerVersion?: string;
  state: AssuranceCoverageState;
  supportedLanguages: string[];
  filesEligible: number;
  filesAnalyzed: number;
  diagnosticsProduced: number;
  durationMs?: number;
  limitationIds: string[];
}

/** Machine-readable coverage for the exact source snapshot. */
export interface AssuranceCoverage {
  status: 'complete' | 'partial' | 'unavailable';
  filesTotal: number;
  filesEligible: number;
  filesAnalyzed: number;
  changedFilesTotal: number;
  changedFilesAnalyzed: number;
  analyzers: AssuranceAnalyzerCoverage[];
  limitations: AssuranceCoverageLimitation[];
  calculatedAt: string;
}
