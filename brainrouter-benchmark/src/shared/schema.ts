export type BenchmarkTrack = "memory" | "cli";
export type BenchmarkStatus = "passed" | "failed" | "unavailable" | "skipped";

export interface BenchmarkRecord {
  id: string;
  sessionId?: string;
  role?: string;
  timestamp?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkQuery {
  id: string;
  query: string;
  goldRecordIds: string[];
  answer?: string;
  options?: string[];
  correctOption?: string;
  category?: string;
  scenario?: "participation" | "observation";
  memoryLevel?: "factual" | "reflective";
}

export interface BenchmarkDataset {
  id: string;
  version: string;
  source: string;
  description?: string;
  metadata?: Record<string, unknown>;
  records: BenchmarkRecord[];
  queries: BenchmarkQuery[];
}

export interface DatasetManifestSource {
  paper?: string;
  paperPdf?: string;
  aclPdf?: string;
  repository?: string;
  downloads?: Array<{
    label: string;
    url: string;
    note?: string;
  }>;
}

export interface DatasetManifestSplit {
  id: string;
  scenario: "participation" | "observation";
  memoryLevel: "factual" | "reflective";
  lengthBucket: string;
  upstreamDataset: string;
  expectedConvertedPath: string;
  rawHints?: string[];
}

export interface DatasetManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  source: DatasetManifestSource;
  notes?: string[];
  splits: DatasetManifestSplit[];
}

export interface BenchmarkRunConfig {
  runId: string;
  track: BenchmarkTrack;
  suite: string;
  fixture: string;
  seed: number;
  fixedNow: string;
  outputDir: string;
  systems: string[];
}

export interface RankedResult {
  recordId: string;
  score: number;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemAdapter {
  id: string;
  label: string;
  kind: "brainrouter" | "peer" | "baseline";
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  setup?(dataset: BenchmarkDataset): Promise<void>;
  ingest(records: BenchmarkRecord[]): Promise<void>;
  query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]>;
  teardown?(): Promise<void>;
}

export interface BenchmarkMetricSet {
  recallAt5?: number;
  recallAt10?: number;
  recallAt20?: number;
  precisionAt5?: number;
  precisionAt10?: number;
  ndcgAt10?: number;
  mrr?: number;
  p50Ms?: number;
  p90Ms?: number;
  p99Ms?: number;
  tokensPerQuery?: number;
  passRate?: number;
  errors?: number;
  [key: string]: number | undefined;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  runId: string;
  track: BenchmarkTrack;
  suite: string;
  systemId: string;
  status: BenchmarkStatus;
  metrics: BenchmarkMetricSet;
  startedAt: string;
  completedAt: string;
  fixture?: string;
  unavailableReason?: string;
  perQuery?: Array<{
    queryId: string;
    category?: string;
    goldRecordIds: string[];
    retrievedRecordIds: string[];
    latencyMs: number;
    metrics: BenchmarkMetricSet;
  }>;
  artifacts?: Record<string, string>;
  environment?: Record<string, string>;
}
