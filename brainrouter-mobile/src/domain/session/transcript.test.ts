// Unit tests for the pure transcript reducer — the spine that folds the agent
// event stream (AgentEvent) into the Session screen's render-ready transcript.
// Run via `npm run test:domain` (tsx --test), matching the ported domain harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import { emptyTranscript, reduceTranscript, type TranscriptState } from './transcript.js';

/** Fold raw events through the reducer, stamping a monotonic seq (mirrors the
 *  host's per-session sequence; transcript row ids derive from it). */
function feed(events: AgentEvent[], from: TranscriptState = emptyTranscript()): TranscriptState {
  let state = from;
  let seq = 0;
  for (const event of events) {
    const msg: AgentEventMessage = { seq: ++seq, ts: 0, sessionKey: 'dev:test', event };
    state = reduceTranscript(state, msg);
  }
  return state;
}

test('turn-start records the prompt as a user row and marks the turn running', () => {
  const s = feed([{ kind: 'turn-start', prompt: 'fix the bug' }]);
  assert.deepEqual(s.items, [{ id: 'u1', kind: 'user', text: 'fix the bug' }]);
  assert.equal(s.running, true);
});

test('assistant deltas accumulate into a single streaming assistant row', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: 'Hello ' },
    { kind: 'assistant-delta', text: 'world' },
  ]);
  assert.deepEqual(s.items, [{ id: 'a1', kind: 'assistant', text: 'Hello world', streaming: true }]);
});

test('assistant-delta with no preceding turn-start still opens an assistant row', () => {
  const s = feed([{ kind: 'assistant-delta', text: 'hi' }]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, 'assistant');
});

test('assistant-turn-end stops the assistant row streaming', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: 'done' },
    { kind: 'assistant-turn-end' },
  ]);
  const row = s.items[0];
  assert.equal(row.kind, 'assistant');
  if (row.kind === 'assistant') assert.equal(row.streaming, false);
});

test('tool-start then tool-end correlate by callId into one resolved tool row', () => {
  const s = feed([
    { kind: 'tool-start', tool: 'read_file', args: { path: 'a.ts' }, callId: 'c1' },
    { kind: 'tool-end', tool: 'read_file', ok: true, summary: 'read a.ts (42 lines)', callId: 'c1' },
  ]);
  assert.equal(s.items.length, 1);
  const row = s.items[0];
  assert.equal(row.kind, 'tool');
  if (row.kind === 'tool') {
    assert.equal(row.callId, 'c1');
    assert.equal(row.tool, 'read_file');
    assert.equal(row.status, 'ok');
    assert.equal(row.summary, 'read a.ts (42 lines)');
    assert.deepEqual(row.args, { path: 'a.ts' });
  }
});

test('a failed tool-end marks the tool row as error', () => {
  const s = feed([
    { kind: 'tool-start', tool: 'run_command', args: {}, callId: 'c9' },
    { kind: 'tool-end', tool: 'run_command', ok: false, summary: 'exit 1', callId: 'c9' },
  ]);
  const row = s.items[0];
  assert.equal(row.kind === 'tool' && row.status, 'error');
});

test('tool-end with no matching tool-start still appends a completed tool row', () => {
  const s = feed([{ kind: 'tool-end', tool: 'grep', ok: true, summary: 'done', callId: 'orphan' }]);
  assert.equal(s.items.length, 1);
  const row = s.items[0];
  assert.equal(row.kind, 'tool');
  if (row.kind === 'tool') assert.equal(row.status, 'ok');
});

test('interaction-request surfaces as the pending interaction', () => {
  const request = { id: 'ir1', type: 'confirm', title: 'Allow run_command?', detail: 'npm test', tool: 'run_command' } as const;
  const s = feed([{ kind: 'interaction-request', request }]);
  assert.deepEqual(s.pendingInteraction, request);
});

test('plan-update stores the latest plan, not a transcript row', () => {
  const items = [{ step: 'Audit', status: 'completed' as const }];
  const s = feed([{ kind: 'plan-update', items, explanation: 'fix' }]);
  assert.deepEqual(s.plan, { items, explanation: 'fix' });
  assert.equal(s.items.length, 0);
});

test('tokens-updated stores the token usage', () => {
  const s = feed([{ kind: 'tokens-updated', promptTokens: 100, completionTokens: 20, calls: 2, turns: 1, cachedTokens: 5 }]);
  assert.deepEqual(s.tokens, { promptTokens: 100, completionTokens: 20, calls: 2, turns: 1, cachedTokens: 5 });
});

test('turn-complete clears running and finalizes streaming rows', () => {
  const s = feed([
    { kind: 'turn-start', prompt: 'hi' },
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: 'partial' },
    { kind: 'turn-complete', answer: 'partial' },
  ]);
  assert.equal(s.running, false);
  const a = s.items.find((i) => i.kind === 'assistant');
  assert.ok(a && a.kind === 'assistant' && a.streaming === false);
});

test('turn-error stops the turn and records an error notice', () => {
  const s = feed([
    { kind: 'turn-start', prompt: 'hi' },
    { kind: 'turn-error', message: 'boom' },
  ]);
  assert.equal(s.running, false);
  const last = s.items[s.items.length - 1];
  assert.equal(last.kind, 'notice');
  if (last.kind === 'notice') {
    assert.equal(last.level, 'error');
    assert.equal(last.text, 'boom');
  }
});

test('a notice event appends a notice row', () => {
  const s = feed([{ kind: 'notice', level: 'warn', message: 'heads up' }]);
  assert.deepEqual(s.items, [{ id: 'n1', kind: 'notice', level: 'warn', text: 'heads up' }]);
});

test('an unhandled event kind leaves the state unchanged', () => {
  const before = emptyTranscript();
  const after = reduceTranscript(before, { seq: 1, ts: 0, sessionKey: 's', event: { kind: 'files-changed' } });
  assert.deepEqual(after, before);
});

// ── reasoning-model <think> handling (Qwen et al.) + benign recall-miss suppression ──

test('<think> content routes to a reasoning row and is stripped from the answer', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: '<think>weigh options</think>The answer is 4.' },
    { kind: 'turn-complete', answer: 'The answer is 4.' },
  ]);
  const reasoning = s.items.find((i) => i.kind === 'reasoning');
  const assistant = s.items.find((i) => i.kind === 'assistant');
  assert.ok(reasoning && reasoning.kind === 'reasoning' && reasoning.text === 'weigh options');
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.text === 'The answer is 4.');
});

test('a leading <think> split across deltas is parsed without leaking tag fragments', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: '<thi' },
    { kind: 'assistant-delta', text: 'nk>secret reasoning</thi' },
    { kind: 'assistant-delta', text: 'nk>The answer.' },
    { kind: 'turn-complete', answer: 'The answer.' },
  ]);
  const reasoning = s.items.find((i) => i.kind === 'reasoning');
  const assistant = s.items.find((i) => i.kind === 'assistant');
  assert.ok(reasoning && reasoning.kind === 'reasoning' && reasoning.text === 'secret reasoning');
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.text === 'The answer.', 'no tag fragments leak');
});

test('a <think> that appears mid-answer is left untouched (literal text / code)', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: 'Use <think> tags like this.' },
    { kind: 'turn-complete', answer: 'Use <think> tags like this.' },
  ]);
  assert.ok(!s.items.some((i) => i.kind === 'reasoning'), 'no reasoning extracted from a mid-answer tag');
  const assistant = s.items.find((i) => i.kind === 'assistant');
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.text === 'Use <think> tags like this.');
});

test('token-by-token <think> stream keeps reasoning and answer separate', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: '<think>' },
    { kind: 'assistant-delta', text: 'plan ' },
    { kind: 'assistant-delta', text: 'it' },
    { kind: 'assistant-delta', text: '</think>' },
    { kind: 'assistant-delta', text: 'Paris.' },
    { kind: 'turn-complete', answer: 'Paris.' },
  ]);
  const reasoning = s.items.find((i) => i.kind === 'reasoning');
  const assistant = s.items.find((i) => i.kind === 'assistant');
  assert.ok(reasoning && reasoning.kind === 'reasoning' && reasoning.text === 'plan it');
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.text === 'Paris.');
});

test('an empty <think></think> block yields no reasoning row and a clean answer', () => {
  const s = feed([
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: '<think>\n\n</think>\n\nParis.' },
    { kind: 'turn-complete', answer: 'Paris.' },
  ]);
  assert.ok(!s.items.some((i) => i.kind === 'reasoning'), 'whitespace-only reasoning is dropped');
  const assistant = s.items.find((i) => i.kind === 'assistant');
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.text === 'Paris.', 'answer trimmed of the think gap');
});

test('the benign "No transcript found" turn-error is suppressed (no error notice)', () => {
  const s = feed([
    { kind: 'turn-error', message: 'No transcript found for "qwen-test".' },
    { kind: 'turn-start', prompt: 'hi' },
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: 'Paris.' },
    { kind: 'turn-complete', answer: 'Paris.' },
  ]);
  assert.ok(!s.items.some((i) => i.kind === 'notice'), 'recall-miss is not shown as an error');
  assert.equal(s.running, false);
  assert.ok(s.items.some((i) => i.kind === 'assistant'));
});

test('the full core-loop sequence builds a user + assistant + tool transcript', () => {
  const s = feed([
    { kind: 'turn-start', prompt: 'summarize' },
    { kind: 'assistant-turn-start' },
    { kind: 'assistant-delta', text: 'Working on it' },
    { kind: 'assistant-delta', text: '… here is what I found.' },
    { kind: 'tool-start', tool: 'read_file', args: { path: 'src/memory/recall.ts' }, callId: 'c1' },
    { kind: 'tool-end', tool: 'read_file', ok: true, summary: 'read src/memory/recall.ts (42 lines)', callId: 'c1' },
    { kind: 'plan-update', items: [{ step: 'Audit', status: 'completed' as const }], explanation: 'fix' },
    { kind: 'assistant-turn-end' },
    { kind: 'tokens-updated', promptTokens: 38000, completionTokens: 1200, calls: 3, turns: 1, cachedTokens: 12000 },
    { kind: 'turn-complete', answer: 'echo: summarize' },
  ]);
  assert.deepEqual(s.items.map((i) => i.kind), ['user', 'assistant', 'tool']);
  const assistant = s.items[1];
  assert.ok(assistant.kind === 'assistant');
  if (assistant.kind === 'assistant') {
    assert.equal(assistant.text, 'Working on it… here is what I found.');
    assert.equal(assistant.streaming, false);
  }
  const tool = s.items[2];
  assert.equal(tool.kind === 'tool' && tool.status, 'ok');
  assert.equal(s.running, false);
  assert.deepEqual(s.plan?.items, [{ step: 'Audit', status: 'completed' }]);
  assert.ok(s.tokens && s.tokens.promptTokens === 38000);
});
