import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRootContextEnvelope,
  contextCompactionMessages,
  inspectContextEnvelope,
  lastUserMessageFromEnvelope,
  materializeContextEnvelope,
  type ContextEnvelopeMessage,
} from '../context/contextEnvelope.js';

test('root context envelope exposes typed prompt layers without changing wire messages', () => {
  const messages: ContextEnvelopeMessage[] = [
    {
      role: 'system',
      content: 'flat system fallback',
      promptLayers: {
        instructions: 'required security policy',
        developer: [
          '## Memory-First Workflow\nUse the existing memory engine.',
          '## Active persona\nPersona: engineer.',
          '## Active capability\nCapability: backend.',
          '## Active skill instructions\nSkill instructions: backend testing.',
        ],
        environment: '# Workspace Instructions\nUse AGENT.md.\n\n# Runtime Context\n/repo',
      },
    },
    { role: 'user', content: 'Implement the bounded change.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
      }],
    },
    {
      role: 'tool',
      name: 'read_file',
      tool_call_id: 'call_1',
      content: 'source content',
    },
  ];

  const envelope = buildRootContextEnvelope(messages, {
    executionId: 'root-test',
    budget: { maxChars: 80_000, maxTokens: 20_000, maxCompactionIterations: 4 },
  });
  const inspection = inspectContextEnvelope(envelope);

  assert.deepEqual(materializeContextEnvelope(envelope), messages);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.executionId, 'root-test');
  assert.deepEqual(envelope.budget, {
    maxChars: 80_000,
    maxTokens: 20_000,
    maxCompactionIterations: 4,
  });
  assert.deepEqual(
    inspection.layers.map((layer) => layer.kind),
    [
      'required-policy',
      'required-policy',
      'persona',
      'capability',
      'skill',
      'source',
      'recent-messages',
      'recent-messages',
      'tool-state',
    ],
  );
  assert.equal(inspection.layers.find((layer) => layer.kind === 'persona')?.protected, true);
  assert.equal(inspection.layers.find((layer) => layer.kind === 'capability')?.inheritToChild, 'never');
  assert.equal(inspection.layers.find((layer) => layer.kind === 'source')?.provenance.source, 'workspace-instructions');
  assert.equal(inspection.layers.find((layer) => layer.kind === 'tool-state')?.untrusted, true);
  assert.equal(lastUserMessageFromEnvelope(envelope), 'Implement the bounded change.');
  assert.deepEqual(
    contextCompactionMessages(envelope).map((message) => message.role),
    ['user', 'assistant', 'tool'],
  );
});

test('same replacement key keeps only the latest transient layer', () => {
  const messages: ContextEnvelopeMessage[] = [
    { role: 'system', content: 'required policy' },
    { role: 'system', content: '<!--brainrouter:goal-anchor-->\nold plan state' },
    { role: 'system', content: '<!--brainrouter:goal-anchor-->\nnew plan state' },
    { role: 'user', content: 'continue' },
  ];

  const envelope = buildRootContextEnvelope(messages);
  const materialized = materializeContextEnvelope(envelope);
  const planLayers = envelope.layers.filter((layer) => layer.kind === 'plan-state');

  assert.equal(planLayers.length, 1);
  assert.match(planLayers[0].content, /new plan state/);
  assert.equal(materialized.some((message) => String(message.content).includes('old plan state')), false);
  assert.equal(materialized.some((message) => String(message.content).includes('new plan state')), true);
});

test('tagged workspace persona and capability overlays are protected replacement layers', () => {
  const envelope = buildRootContextEnvelope([
    { role: 'system', content: 'required policy' },
    { role: 'system', content: '<!--brainrouter:workspace-domain-persona-->\nPersona: engineer' },
    { role: 'system', content: '<!--brainrouter:workspace-capabilities-->\nCapability: backend' },
    { role: 'user', content: 'Build the service.' },
  ]);
  const inspection = inspectContextEnvelope(envelope);
  const persona = inspection.layers.find((layer) => layer.kind === 'persona');
  const capability = inspection.layers.find((layer) => layer.kind === 'capability');

  assert.equal(persona?.protected, true);
  assert.equal(persona?.provenance.source, 'persona-catalog');
  assert.equal(capability?.protected, true);
  assert.equal(capability?.provenance.source, 'capability-resolver');
  assert.equal(capability?.inheritToChild, 'never');
});

test('a prior compacted summary is selected for recursive compaction without the protected prompt', () => {
  const messages: ContextEnvelopeMessage[] = [{
    role: 'system',
    content: 'flat fallback with prior summary',
    promptLayers: {
      instructions: 'protected policy',
      developer: [
        '## Compacted conversation summary\nPrior decisions and unresolved constraints.',
      ],
      environment: '',
    },
  }, {
    role: 'user',
    content: 'new work',
  }];

  const selected = contextCompactionMessages(buildRootContextEnvelope(messages));

  assert.equal(selected.some((message) => String(message.content).includes('protected policy')), false);
  assert.equal(selected.some((message) => String(message.content).includes('Prior decisions')), true);
  assert.equal(selected.at(-1)?.content, 'new work');
});

test('inspection reports per-layer and envelope budget overflow without mutating content', () => {
  const messages: ContextEnvelopeMessage[] = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'x'.repeat(1_000) },
  ];
  const envelope = buildRootContextEnvelope(messages, {
    budget: { maxChars: 100, maxTokens: 25 },
  });
  const before = structuredClone(messages);
  const inspection = inspectContextEnvelope(envelope);

  assert.equal(inspection.overBudget, true);
  assert.ok(inspection.totalChars > inspection.maxChars);
  assert.deepEqual(materializeContextEnvelope(envelope), before);
});
