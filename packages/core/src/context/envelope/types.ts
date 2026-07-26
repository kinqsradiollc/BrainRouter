import type { PromptLayers } from '../../prompt/systemPrompt.js';

export const CONTEXT_LAYER_ORDER = [
  'required-policy',
  'persona',
  'capability',
  'orchestration',
  'plan-state',
  'memory-briefing',
  'skill',
  'source',
  'conversation-summary',
  'recent-messages',
  'tool-state',
] as const;

export type ContextLayerKind = typeof CONTEXT_LAYER_ORDER[number];

export type ContextCompactionPolicy =
  | 'preserve'
  | 'replace'
  | 'summarize'
  | 'summarize-older'
  | 'compact-completed'
  | 'tool-summary'
  | 'discard-superseded';

export type ContextInheritancePolicy = 'always' | 'selected' | 'never';

export type ContextProvenanceSource =
  | 'runtime-policy'
  | 'workspace-instructions'
  | 'workspace-manifest'
  | 'persona-catalog'
  | 'capability-resolver'
  | 'orchestration'
  | 'plan'
  | 'memory-engine'
  | 'skill-catalog'
  | 'knowledge'
  | 'conversation'
  | 'tool-runtime'
  | 'compaction';

export interface ContextProvenance {
  source: ContextProvenanceSource;
  /** Stable source identity, never a secret value. */
  reference: string;
}

export interface ContextLayerBudget {
  maxChars: number;
  maxTokens: number;
}

export interface ContextEnvelopeBudget extends ContextLayerBudget {
  /** Hard bound on compaction passes for this envelope. */
  maxCompactionIterations: number;
}

export interface ContextEnvelopeMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
  images?: any[];
  meta?: Record<string, unknown>;
  promptLayers?: PromptLayers;
}

export interface ContextLayer {
  /** Stable within an envelope snapshot. */
  id: string;
  kind: ContextLayerKind;
  /** Same kind + replacement key replaces rather than accumulates. */
  replacementKey: string;
  provenance: ContextProvenance;
  priority: number;
  budget: ContextLayerBudget;
  compaction: ContextCompactionPolicy;
  inheritToChild: ContextInheritancePolicy;
  mayContainSecrets: boolean;
  untrusted: boolean;
  /** Protected layers may be replaced by a newer version but never summarized. */
  protected: boolean;
  /** Inspectable content owned by this layer. */
  content: string;
  /** Wire messages emitted by this layer. Metadata-only sublayers use none. */
  messages: ContextEnvelopeMessage[];
  /** Original materialization position. */
  sequence: number;
}

export interface ContextEnvelope {
  schemaVersion: 1;
  executionId: string;
  budget: ContextEnvelopeBudget;
  layers: ContextLayer[];
}

export interface ContextEnvelopeInspection {
  schemaVersion: 1;
  executionId: string;
  totalChars: number;
  estimatedTokens: number;
  maxChars: number;
  maxTokens: number;
  overBudget: boolean;
  layers: Array<{
    id: string;
    kind: ContextLayerKind;
    replacementKey: string;
    provenance: ContextProvenance;
    chars: number;
    estimatedTokens: number;
    priority: number;
    maxChars: number;
    maxTokens: number;
    overBudget: boolean;
    compaction: ContextCompactionPolicy;
    protected: boolean;
    inheritToChild: ContextInheritancePolicy;
    mayContainSecrets: boolean;
    untrusted: boolean;
  }>;
}

export interface ContextCompactionStage {
  stage:
    | 'discard-superseded'
    | 'summarize-tool-state'
    | 'summarize-conversation'
    | 'compact-plan'
    | 'discard-replaced-transient';
  beforeChars: number;
  afterChars: number;
  progress: boolean;
}

export interface ContextCompactionResult {
  status: 'fit' | 'compacted' | 'cannot-fit';
  envelope: ContextEnvelope;
  beforeChars: number;
  afterChars: number;
  iterations: number;
  stages: ContextCompactionStage[];
  reason?: string;
}

export interface ContextCompactionOptions {
  targetChars: number;
  summary: string;
  /** The current base prompt, regenerated immediately before compaction. */
  requiredSystemMessage?: ContextEnvelopeMessage;
  maxIterations?: number;
}
