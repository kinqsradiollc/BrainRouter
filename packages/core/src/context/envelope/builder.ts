/**
 * Typed, inspectable context composition for root and delegated executions.
 *
 * The envelope is deliberately in-memory. Durable facts continue through the
 * memory subsystem and project sources continue through the knowledge
 * subsystem; this module only describes the bounded material selected for one
 * model request.
 */

import { createHash } from 'node:crypto';
import type { PromptLayers } from '../../prompt/systemPrompt.js';
import type {
  ContextCompactionPolicy,
  ContextEnvelope,
  ContextEnvelopeBudget,
  ContextEnvelopeInspection,
  ContextEnvelopeMessage,
  ContextInheritancePolicy,
  ContextLayer,
  ContextLayerBudget,
  ContextLayerKind,
  ContextProvenance,
} from './types.js';

const DEFAULT_TOTAL_BUDGET: ContextEnvelopeBudget = {
  maxChars: 400_000,
  maxTokens: 100_000,
  maxCompactionIterations: 5,
};

const LAYER_DEFAULTS: Record<ContextLayerKind, {
  priority: number;
  budget: ContextLayerBudget;
  compaction: ContextCompactionPolicy;
  inheritToChild: ContextInheritancePolicy;
  mayContainSecrets: boolean;
  untrusted: boolean;
  protected: boolean;
}> = {
  'required-policy': layerDefaults(100, 64_000, 'preserve', 'always', false, false, true),
  persona: layerDefaults(90, 12_000, 'replace', 'selected', false, false, true),
  capability: layerDefaults(85, 20_000, 'replace', 'never', false, false, true),
  orchestration: layerDefaults(85, 20_000, 'replace', 'selected', false, false, true),
  'plan-state': layerDefaults(75, 32_000, 'compact-completed', 'selected', false, false, false),
  'memory-briefing': layerDefaults(70, 32_000, 'summarize', 'selected', true, false, false),
  skill: layerDefaults(80, 48_000, 'replace', 'selected', false, false, true),
  source: layerDefaults(65, 80_000, 'summarize', 'selected', true, true, false),
  'conversation-summary': layerDefaults(70, 32_000, 'replace', 'selected', true, true, false),
  'recent-messages': layerDefaults(60, 120_000, 'summarize-older', 'never', true, true, false),
  'tool-state': layerDefaults(55, 64_000, 'tool-summary', 'never', true, true, false),
};

function layerDefaults(
  priority: number,
  maxChars: number,
  compaction: ContextCompactionPolicy,
  inheritToChild: ContextInheritancePolicy,
  mayContainSecrets: boolean,
  untrusted: boolean,
  isProtected: boolean,
) {
  return {
    priority,
    budget: { maxChars, maxTokens: Math.ceil(maxChars / 4) },
    compaction,
    inheritToChild,
    mayContainSecrets,
    untrusted,
    protected: isProtected,
  };
}

export class ContextEnvelopeBuilder {
  private readonly layers: ContextLayer[] = [];

  constructor(
    private readonly executionId: string,
    private readonly budget: ContextEnvelopeBudget = DEFAULT_TOTAL_BUDGET,
  ) {
    validateBudget(budget, 'envelope');
  }

  upsert(input: Omit<ContextLayer, 'sequence'> & { sequence?: number }): this {
    validateLayer(input);
    const key = replacementIdentity(input);
    const existingIndex = this.layers.findIndex((layer) => replacementIdentity(layer) === key);
    const sequence = existingIndex >= 0
      ? this.layers[existingIndex].sequence
      : input.sequence ?? this.layers.length;
    const layer: ContextLayer = {
      ...input,
      budget: { ...input.budget },
      provenance: { ...input.provenance },
      messages: input.messages.map(cloneMessage),
      sequence,
    };
    if (existingIndex >= 0) this.layers[existingIndex] = layer;
    else this.layers.push(layer);
    return this;
  }

  build(): ContextEnvelope {
    return {
      schemaVersion: 1,
      executionId: this.executionId,
      budget: { ...this.budget },
      layers: this.layers
        .map(cloneLayer)
        .sort((a, b) => a.sequence - b.sequence),
    };
  }
}

/**
 * Adapt the current root chat history into typed layers without changing the
 * wire message order or payload. Prompt-layer metadata is exposed as
 * independently inspectable layers while only its owner emits the wire message.
 */
export function buildRootContextEnvelope(
  messages: readonly ContextEnvelopeMessage[],
  options: {
    executionId?: string;
    budget?: Partial<ContextEnvelopeBudget>;
  } = {},
): ContextEnvelope {
  const budget = normalizeEnvelopeBudget(options.budget);
  const executionId = options.executionId?.trim() || 'root';
  const builder = new ContextEnvelopeBuilder(executionId, budget);
  let sequence = 0;

  messages.forEach((message, index) => {
    if (index === 0 && message.role === 'system') {
      const layers = promptLayersOf(message);
      if (layers) {
        builder.upsert(makeLayer({
          id: 'required-policy:system',
          kind: 'required-policy',
          replacementKey: 'system',
          provenance: { source: 'runtime-policy', reference: 'system-prompt' },
          content: layers.instructions,
          messages: [message],
          sequence: sequence++,
        }));
        layers.developer.forEach((content, developerIndex) => {
          const classification = classifyDeveloperLayer(content);
          builder.upsert(makeLayer({
            id: `${classification.kind}:developer-${developerIndex}-${shortHash(content)}`,
            kind: classification.kind,
            replacementKey: classification.replacementKey,
            provenance: classification.provenance,
            content,
            messages: [],
            sequence: sequence++,
          }));
        });
        if (layers.environment.trim()) {
          builder.upsert(makeLayer({
            id: `source:environment-${shortHash(layers.environment)}`,
            kind: 'source',
            replacementKey: 'workspace-environment',
            provenance: { source: 'workspace-instructions', reference: 'workspace-environment' },
            content: layers.environment,
            messages: [],
            sequence: sequence++,
          overrides: {
            protected: true,
            compaction: 'replace',
            untrusted: true,
            mayContainSecrets: true,
            },
          }));
        }
        return;
      }

      const content = messageText(message);
      builder.upsert(makeLayer({
        id: 'required-policy:system',
        kind: 'required-policy',
        replacementKey: 'system',
        provenance: { source: 'runtime-policy', reference: 'system-prompt' },
        content,
        messages: [message],
        sequence: sequence++,
      }));
      return;
    }

    const classification = classifyMessageLayer(message, index);
    builder.upsert(makeLayer({
      id: `${classification.kind}:${index}-${shortHash(messageText(message))}`,
      kind: classification.kind,
      replacementKey: classification.replacementKey,
      provenance: classification.provenance,
      content: messageText(message),
      messages: [message],
      sequence: sequence++,
      overrides: classification.overrides,
    }));
  });

  return builder.build();
}

export function materializeContextEnvelope(envelope: ContextEnvelope): ContextEnvelopeMessage[] {
  return envelope.layers
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((layer) => layer.messages.map(cloneMessage));
}

export function inspectContextEnvelope(envelope: ContextEnvelope): ContextEnvelopeInspection {
  const layers = envelope.layers.map((layer) => {
    const chars = layer.content.length;
    const estimatedTokens = estimateTokens(chars);
    return {
      id: layer.id,
      kind: layer.kind,
      replacementKey: layer.replacementKey,
      provenance: { ...layer.provenance },
      chars,
      estimatedTokens,
      priority: layer.priority,
      maxChars: layer.budget.maxChars,
      maxTokens: layer.budget.maxTokens,
      overBudget: chars > layer.budget.maxChars || estimatedTokens > layer.budget.maxTokens,
      compaction: layer.compaction,
      protected: layer.protected,
      inheritToChild: layer.inheritToChild,
      mayContainSecrets: layer.mayContainSecrets,
      untrusted: layer.untrusted,
    };
  });
  const totalChars = layers.reduce((sum, layer) => sum + layer.chars, 0);
  const estimatedTokens = layers.reduce((sum, layer) => sum + layer.estimatedTokens, 0);
  return {
    schemaVersion: 1,
    executionId: envelope.executionId,
    totalChars,
    estimatedTokens,
    maxChars: envelope.budget.maxChars,
    maxTokens: envelope.budget.maxTokens,
    overBudget: totalChars > envelope.budget.maxChars || estimatedTokens > envelope.budget.maxTokens,
    layers,
  };
}

/** Messages safe to send to the summarizer; protected prompt layers stay out. */
export function contextCompactionMessages(envelope: ContextEnvelope): ContextEnvelopeMessage[] {
  return envelope.layers
    .filter((layer) => !layer.protected)
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((layer) => layer.messages.length > 0
      ? layer.messages.map(cloneMessage)
      : [{
          role: 'system',
          name: `context-${layer.kind}`,
          content: layer.content,
          meta: { contextLayer: layer.kind, provenance: layer.provenance.reference },
        }]);
}

export function lastUserMessageFromEnvelope(envelope: ContextEnvelope): string | undefined {
  const messages = materializeContextEnvelope(envelope);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messageText(messages[index]);
  }
  return undefined;
}

function makeLayer(input: {
  id: string;
  kind: ContextLayerKind;
  replacementKey: string;
  provenance: ContextProvenance;
  content: string;
  messages: ContextEnvelopeMessage[];
  sequence: number;
  overrides?: Partial<Pick<ContextLayer,
    'priority' | 'budget' | 'compaction' | 'inheritToChild'
    | 'mayContainSecrets' | 'untrusted' | 'protected'>>;
}): Omit<ContextLayer, 'sequence'> & { sequence: number } {
  const defaults = LAYER_DEFAULTS[input.kind];
  return {
    id: input.id,
    kind: input.kind,
    replacementKey: input.replacementKey,
    provenance: input.provenance,
    priority: input.overrides?.priority ?? defaults.priority,
    budget: { ...(input.overrides?.budget ?? defaults.budget) },
    compaction: input.overrides?.compaction ?? defaults.compaction,
    inheritToChild: input.overrides?.inheritToChild ?? defaults.inheritToChild,
    mayContainSecrets: input.overrides?.mayContainSecrets ?? defaults.mayContainSecrets,
    untrusted: input.overrides?.untrusted ?? defaults.untrusted,
    protected: input.overrides?.protected ?? defaults.protected,
    content: input.content,
    messages: input.messages,
    sequence: input.sequence,
  };
}

function classifyDeveloperLayer(content: string): {
  kind: ContextLayerKind;
  replacementKey: string;
  provenance: ContextProvenance;
} {
  const lower = content.toLowerCase();
  if (lower.includes('compacted conversation summary')) {
    return {
      kind: 'conversation-summary',
      replacementKey: 'active-summary',
      provenance: { source: 'compaction', reference: 'bounded-history-summary' },
    };
  }
  if (lower.includes('memory-first workflow') || lower.includes('brainrouter mcp is offline')) {
    return {
      kind: 'required-policy',
      replacementKey: 'memory-posture',
      provenance: { source: 'runtime-policy', reference: 'memory-posture' },
    };
  }
  if (lower.includes('active skill') || lower.includes('skill instructions')) {
    return {
      kind: 'skill',
      replacementKey: `skill:${headingKey(content)}`,
      provenance: { source: 'skill-catalog', reference: headingKey(content) },
    };
  }
  if (lower.includes('persona')) {
    return {
      kind: 'persona',
      replacementKey: 'active-persona',
      provenance: { source: 'persona-catalog', reference: 'active-persona' },
    };
  }
  if (lower.includes('capability')) {
    return {
      kind: 'capability',
      replacementKey: `capability:${headingKey(content)}`,
      provenance: { source: 'capability-resolver', reference: headingKey(content) },
    };
  }
  return {
    kind: 'orchestration',
    replacementKey: `developer:${headingKey(content)}`,
    provenance: { source: 'runtime-policy', reference: headingKey(content) },
  };
}

function classifyMessageLayer(message: ContextEnvelopeMessage, index: number): {
  kind: ContextLayerKind;
  replacementKey: string;
  provenance: ContextProvenance;
  overrides?: Partial<Pick<ContextLayer,
    'priority' | 'budget' | 'compaction' | 'inheritToChild'
    | 'mayContainSecrets' | 'untrusted' | 'protected'>>;
} {
  const content = messageText(message);
  const tag = contextTag(content);
  if (message.role === 'tool') {
    const reference = String(message.tool_call_id ?? message.name ?? `tool-${index}`);
    return {
      kind: 'tool-state',
      replacementKey: `tool:${reference}`,
      provenance: { source: 'tool-runtime', reference },
    };
  }
  if (message.role === 'system' || message.role === 'developer') {
    if (tag?.includes('persona') || tag?.includes('profile')) {
      return {
        kind: 'persona',
        replacementKey: tag,
        provenance: { source: 'persona-catalog', reference: tag },
        overrides: { protected: true, compaction: 'replace' },
      };
    }
    if (tag?.includes('capabilit')) {
      return {
        kind: 'capability',
        replacementKey: tag,
        provenance: { source: 'capability-resolver', reference: tag },
        overrides: { protected: true, compaction: 'replace' },
      };
    }
    if (tag?.includes('briefing')) {
      return {
        kind: 'memory-briefing',
        replacementKey: tag,
        provenance: { source: 'memory-engine', reference: tag },
      };
    }
    if (tag?.includes('skill')) {
      return {
        kind: 'skill',
        replacementKey: tag,
        provenance: { source: 'skill-catalog', reference: tag },
      };
    }
    if (tag?.includes('goal') || tag?.includes('plan') || tag?.includes('checkpoint')) {
      return {
        kind: 'plan-state',
        replacementKey: tag,
        provenance: { source: 'plan', reference: tag },
      };
    }
    if (tag?.includes('child') || tag?.includes('fan-out') || tag?.includes('orchestration')) {
      return {
        kind: 'orchestration',
        replacementKey: tag,
        provenance: { source: 'orchestration', reference: tag },
        overrides: { protected: true, compaction: 'replace' },
      };
    }
    if (content.toLowerCase().includes('compacted conversation summary')) {
      return {
        kind: 'conversation-summary',
        replacementKey: 'active-summary',
        provenance: { source: 'compaction', reference: 'bounded-history-summary' },
      };
    }
    return {
      kind: 'plan-state',
      replacementKey: tag ?? `runtime:${index}`,
      provenance: { source: 'runtime-policy', reference: tag ?? `runtime-message-${index}` },
    };
  }
  return {
    kind: 'recent-messages',
    replacementKey: `message:${index}`,
    provenance: { source: 'conversation', reference: `message-${index}` },
  };
}

function promptLayersOf(message: ContextEnvelopeMessage): PromptLayers | undefined {
  const layers = message.promptLayers;
  if (!layers || typeof layers.instructions !== 'string'
    || !Array.isArray(layers.developer)
    || typeof layers.environment !== 'string') return undefined;
  return {
    instructions: layers.instructions,
    developer: layers.developer.map(String),
    environment: layers.environment,
  };
}

function normalizeEnvelopeBudget(input: Partial<ContextEnvelopeBudget> | undefined): ContextEnvelopeBudget {
  const budget = {
    ...DEFAULT_TOTAL_BUDGET,
    ...(input ?? {}),
  };
  validateBudget(budget, 'envelope');
  return budget;
}

function validateLayer(layer: Omit<ContextLayer, 'sequence'> & { sequence?: number }): void {
  if (!/^[a-z0-9][a-z0-9:._-]{0,159}$/i.test(layer.id)) {
    throw new Error(`invalid context layer id: ${layer.id}`);
  }
  if (!layer.replacementKey.trim()) throw new Error(`context layer ${layer.id} needs a replacement key`);
  if (!Number.isFinite(layer.priority)) throw new Error(`context layer ${layer.id} priority must be finite`);
  validateBudget(layer.budget, `context layer ${layer.id}`);
  if (!layer.provenance.reference.trim()) throw new Error(`context layer ${layer.id} needs provenance`);
}

function validateBudget(budget: ContextLayerBudget, label: string): void {
  if (!Number.isFinite(budget.maxChars) || budget.maxChars < 1) {
    throw new Error(`${label} maxChars must be a positive finite number`);
  }
  if (!Number.isFinite(budget.maxTokens) || budget.maxTokens < 1) {
    throw new Error(`${label} maxTokens must be a positive finite number`);
  }
}

function replacementIdentity(layer: Pick<ContextLayer, 'kind' | 'replacementKey'>): string {
  return `${layer.kind}:${layer.replacementKey}`;
}

function cloneMessage(message: ContextEnvelopeMessage): ContextEnvelopeMessage {
  return structuredCloneCompat(message);
}

function cloneLayer(layer: ContextLayer): ContextLayer {
  return {
    ...layer,
    budget: { ...layer.budget },
    provenance: { ...layer.provenance },
    messages: layer.messages.map(cloneMessage),
  };
}

function messageText(message: ContextEnvelopeMessage): string {
  if (typeof message.content === 'string') return message.content;
  try {
    return JSON.stringify(message.content ?? '');
  } catch {
    return String(message.content ?? '');
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function headingKey(content: string): string {
  const heading = content.split(/\r?\n/, 1)[0]
    ?.replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return heading?.slice(0, 80) || shortHash(content);
}

function contextTag(content: string): string | undefined {
  return content.match(/^<!--brainrouter:([a-z0-9-]+)-->/i)?.[1]?.toLowerCase();
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function structuredCloneCompat<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
