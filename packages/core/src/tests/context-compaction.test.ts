import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRootContextEnvelope,
  inspectContextEnvelope,
  materializeContextEnvelope,
  type ContextEnvelopeMessage,
} from '../context/contextEnvelope.js';
import { compactContextEnvelope } from '../context/envelope/compaction.js';

test('bounded compaction preserves policy and the latest user turn with provenance', () => {
  const messages: ContextEnvelopeMessage[] = [
    { role: 'system', content: 'SECURITY POLICY: never reveal credentials.' },
    { role: 'user', content: `old request ${'a'.repeat(1_500)}` },
    { role: 'assistant', content: `old response ${'b'.repeat(1_500)}` },
    {
      role: 'tool',
      name: 'search',
      tool_call_id: 'call_old',
      content: `old tool output ${'c'.repeat(1_500)}`,
    },
    { role: 'system', content: `<!--brainrouter:goal-anchor-->\ncompleted plan ${'d'.repeat(600)}` },
    { role: 'user', content: 'latest request must survive verbatim' },
  ];
  const envelope = buildRootContextEnvelope(messages, {
    budget: { maxChars: 20_000, maxTokens: 5_000, maxCompactionIterations: 5 },
  });
  const result = compactContextEnvelope(envelope, {
    targetChars: 1_000,
    summary: '## Compacted conversation summary\nDecisions, evidence, failures, and pending work.',
  });

  assert.equal(result.status, 'compacted');
  assert.ok(result.afterChars < result.beforeChars);
  assert.equal(result.iterations, 5);
  assert.ok(result.stages.some((stage) => stage.stage === 'summarize-tool-state' && stage.progress));
  assert.ok(result.stages.some((stage) => stage.stage === 'summarize-conversation' && stage.progress));
  assert.ok(result.stages.some((stage) => stage.stage === 'compact-plan' && stage.progress));

  const materialized = materializeContextEnvelope(result.envelope);
  assert.equal(materialized[0].content, messages[0].content);
  assert.equal(materialized.at(-1)?.content, 'latest request must survive verbatim');
  assert.equal(materialized.some((message) => String(message.content).includes('old tool output')), false);
  assert.equal(materialized.some((message) => String(message.content).includes('old request')), false);
  assert.equal(
    inspectContextEnvelope(result.envelope).layers
      .find((layer) => layer.kind === 'conversation-summary')?.provenance.source,
    'compaction',
  );
});

test('compaction fails closed when protected and recent context cannot fit', () => {
  const messages: ContextEnvelopeMessage[] = [
    { role: 'system', content: `protected ${'p'.repeat(2_000)}` },
    { role: 'user', content: `old ${'o'.repeat(1_000)}` },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: `latest ${'l'.repeat(600)}` },
  ];
  const envelope = buildRootContextEnvelope(messages);
  const result = compactContextEnvelope(envelope, {
    targetChars: 100,
    summary: `summary ${'s'.repeat(500)}`,
  });

  assert.equal(result.status, 'cannot-fit');
  assert.match(result.reason ?? '', /protected and recent context/);
  assert.deepEqual(materializeContextEnvelope(result.envelope), messages);
  assert.equal(result.afterChars, result.beforeChars);
});

test('compaction stops at the configured iteration ceiling', () => {
  const messages: ContextEnvelopeMessage[] = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: `old ${'a'.repeat(1_000)}` },
    {
      role: 'tool',
      name: 'search',
      tool_call_id: 'call_1',
      content: `tool ${'b'.repeat(1_000)}`,
    },
    { role: 'assistant', content: `answer ${'c'.repeat(1_000)}` },
    { role: 'user', content: 'latest' },
  ];
  const envelope = buildRootContextEnvelope(messages, {
    budget: { maxCompactionIterations: 2 },
  });
  const result = compactContextEnvelope(envelope, {
    targetChars: 50,
    summary: 'bounded summary',
    maxIterations: 10,
  });

  assert.equal(result.status, 'cannot-fit');
  assert.equal(result.iterations, 2);
  assert.equal(result.stages.length, 2);
  assert.deepEqual(
    result.stages.map((stage) => stage.stage),
    ['discard-superseded', 'summarize-tool-state'],
  );
  assert.deepEqual(materializeContextEnvelope(result.envelope), messages);
});
