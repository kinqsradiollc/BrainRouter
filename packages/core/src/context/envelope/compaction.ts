import { inspectContextEnvelope } from './builder.js';
import type {
  ContextCompactionOptions,
  ContextCompactionResult,
  ContextCompactionStage,
  ContextEnvelope,
  ContextEnvelopeMessage,
  ContextLayer,
} from './types.js';

/**
 * Replace compactable history with one provenance-labelled summary while
 * preserving protected constraints and the latest user turn. Each stage is
 * bounded, records measurable progress, and returns `cannot-fit` instead of
 * discarding protected context.
 */
export function compactContextEnvelope(
  envelope: ContextEnvelope,
  options: ContextCompactionOptions,
): ContextCompactionResult {
  if (!Number.isFinite(options.targetChars) || options.targetChars < 1) {
    throw new Error('context compaction targetChars must be a positive finite number');
  }
  const summary = options.summary.trim();
  if (!summary) throw new Error('context compaction summary must not be empty');

  const original = cloneEnvelope(envelope);
  const beforeChars = inspectContextEnvelope(original).totalChars;
  if (beforeChars <= options.targetChars) {
    return {
      status: 'fit',
      envelope: original,
      beforeChars,
      afterChars: beforeChars,
      iterations: 0,
      stages: [],
    };
  }

  const maxIterations = Math.max(
    1,
    Math.min(
      options.maxIterations ?? original.budget.maxCompactionIterations,
      original.budget.maxCompactionIterations,
      5,
    ),
  );
  let layers = replaceRequiredSystem(original.layers, options.requiredSystemMessage);
  const recentBoundary = lastUserLayerSequence(layers);
  const summaryLayer: ContextLayer = {
    id: 'conversation-summary:compacted',
    kind: 'conversation-summary',
    replacementKey: 'active-summary',
    provenance: { source: 'compaction', reference: 'bounded-history-summary' },
    priority: 70,
    budget: { maxChars: 32_000, maxTokens: 8_000 },
    compaction: 'replace',
    inheritToChild: 'selected',
    mayContainSecrets: true,
    untrusted: true,
    protected: false,
    content: summary,
    messages: [{
      role: 'system',
      content: summary,
      meta: { contextLayer: 'conversation-summary', compacted: true },
    }],
    sequence: summaryInsertionSequence(layers),
  };
  layers = upsertLayer(layers, summaryLayer);
  const latestReplacementSequence = new Map<string, number>();
  for (const layer of layers) {
    latestReplacementSequence.set(replacementIdentity(layer), layer.sequence);
  }

  const stages: ContextCompactionStage[] = [];
  const definitions: Array<{
    stage: ContextCompactionStage['stage'];
    remove: (layer: ContextLayer) => boolean;
  }> = [
    {
      stage: 'discard-superseded',
      remove: (layer) => latestReplacementSequence.get(replacementIdentity(layer)) !== layer.sequence,
    },
    {
      stage: 'summarize-tool-state',
      remove: (layer) => isOlderCompactable(layer, recentBoundary) && layer.kind === 'tool-state',
    },
    {
      stage: 'summarize-conversation',
      remove: (layer) => isOlderCompactable(layer, recentBoundary) && layer.kind === 'recent-messages',
    },
    {
      stage: 'compact-plan',
      remove: (layer) => isOlderCompactable(layer, recentBoundary) && layer.kind === 'plan-state',
    },
    {
      stage: 'discard-replaced-transient',
      remove: (layer) => isOlderCompactable(layer, recentBoundary)
        && ['memory-briefing', 'source'].includes(layer.kind),
    },
  ];

  let iterations = 0;
  for (const definition of definitions) {
    if (iterations >= maxIterations) break;
    const before = layersChars(layers);
    const next = layers.filter((layer) => !definition.remove(layer));
    const after = layersChars(next);
    const progress = after < before;
    stages.push({
      stage: definition.stage,
      beforeChars: before,
      afterChars: after,
      progress,
    });
    iterations += 1;
    if (progress) layers = next;
  }

  const compacted: ContextEnvelope = {
    ...original,
    layers: resequence(layers),
  };
  const afterChars = inspectContextEnvelope(compacted).totalChars;
  if (afterChars >= beforeChars) {
    return cannotFit(
      original,
      beforeChars,
      iterations,
      stages,
      'compaction made no measurable size progress',
    );
  }
  if (afterChars > options.targetChars) {
    return cannotFit(
      original,
      beforeChars,
      iterations,
      stages,
      `protected and recent context requires ${afterChars} chars, above target ${Math.floor(options.targetChars)}`,
    );
  }
  return {
    status: 'compacted',
    envelope: compacted,
    beforeChars,
    afterChars,
    iterations,
    stages,
  };
}

function cannotFit(
  original: ContextEnvelope,
  beforeChars: number,
  iterations: number,
  stages: ContextCompactionStage[],
  reason: string,
): ContextCompactionResult {
  return {
    status: 'cannot-fit',
    envelope: original,
    beforeChars,
    afterChars: beforeChars,
    iterations,
    stages,
    reason,
  };
}

function cloneEnvelope(envelope: ContextEnvelope): ContextEnvelope {
  return {
    ...envelope,
    budget: { ...envelope.budget },
    layers: envelope.layers.map(cloneLayer),
  };
}

function cloneLayer(layer: ContextLayer): ContextLayer {
  return {
    ...layer,
    budget: { ...layer.budget },
    provenance: { ...layer.provenance },
    messages: layer.messages.map(cloneMessage),
  };
}

function cloneMessage(message: ContextEnvelopeMessage): ContextEnvelopeMessage {
  return structuredCloneCompat(message);
}

function replacementIdentity(layer: Pick<ContextLayer, 'kind' | 'replacementKey'>): string {
  return `${layer.kind}:${layer.replacementKey}`;
}

function layersChars(layers: readonly ContextLayer[]): number {
  return layers.reduce((sum, layer) => sum + layer.content.length, 0);
}

function lastUserLayerSequence(layers: readonly ContextLayer[]): number {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    if (layers[index].messages.some((message) => message.role === 'user')) {
      return layers[index].sequence;
    }
  }
  return Number.POSITIVE_INFINITY;
}

function summaryInsertionSequence(layers: readonly ContextLayer[]): number {
  const requiredSystem = layers
    .filter((layer) => layer.kind === 'required-policy' && layer.messages.some((message) => message.role === 'system'))
    .reduce((highest, layer) => Math.max(highest, layer.sequence), -1);
  return requiredSystem + 0.5;
}

function isOlderCompactable(layer: ContextLayer, recentBoundary: number): boolean {
  return !layer.protected
    && layer.kind !== 'conversation-summary'
    && layer.sequence < recentBoundary;
}

function upsertLayer(layers: readonly ContextLayer[], incoming: ContextLayer): ContextLayer[] {
  const key = replacementIdentity(incoming);
  return [
    ...layers.filter((layer) => replacementIdentity(layer) !== key),
    cloneLayer(incoming),
  ].sort((a, b) => a.sequence - b.sequence);
}

function replaceRequiredSystem(
  layers: readonly ContextLayer[],
  message: ContextEnvelopeMessage | undefined,
): ContextLayer[] {
  if (!message) return layers.map(cloneLayer);
  const next = layers.map(cloneLayer);
  const index = next.findIndex((layer) => layer.kind === 'required-policy' && layer.replacementKey === 'system');
  if (index < 0) return next;
  next[index] = {
    ...next[index],
    content: promptInstructions(message),
    messages: [cloneMessage(message)],
    provenance: { source: 'runtime-policy', reference: 'system-prompt' },
  };
  return next;
}

function promptInstructions(message: ContextEnvelopeMessage): string {
  const layers = message.promptLayers;
  if (layers && typeof layers.instructions === 'string') return layers.instructions;
  if (typeof message.content === 'string') return message.content;
  try {
    return JSON.stringify(message.content ?? '');
  } catch {
    return String(message.content ?? '');
  }
}

function resequence(layers: readonly ContextLayer[]): ContextLayer[] {
  return layers
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((layer, sequence) => ({ ...cloneLayer(layer), sequence }));
}

function structuredCloneCompat<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
