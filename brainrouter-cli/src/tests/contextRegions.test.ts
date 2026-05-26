import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppendOnlyLog,
  ContextRegions,
  ImmutablePrefix,
  VolatileScratch,
  type ChatMessage,
  type ToolSpec,
} from '../runtime/contextRegions.js';

const toolA: ToolSpec = {
  type: 'function',
  function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
};

const toolB: ToolSpec = {
  type: 'function',
  function: { name: 'list_directory', description: 'List', parameters: { type: 'object' } },
};

test('ImmutablePrefix fingerprint is stable across reads', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA, toolB] });
  const f1 = prefix.fingerprint;
  const f2 = prefix.fingerprint;
  assert.equal(f1, f2);
  assert.equal(f1.length, 16);
});

test('ImmutablePrefix.replaceSystem only invalidates when content actually changes', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA] });
  const f1 = prefix.fingerprint;

  // Identical replace — must not signal change AND must not invalidate cache.
  assert.equal(prefix.replaceSystem('sys'), false);
  assert.equal(prefix.fingerprint, f1);

  // Real change — signals true AND invalidates.
  assert.equal(prefix.replaceSystem('sys-v2'), true);
  assert.notEqual(prefix.fingerprint, f1);
});

test('ImmutablePrefix.setToolSpecs is idempotent on equal lists', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA, toolB] });
  const f1 = prefix.fingerprint;
  assert.equal(prefix.setToolSpecs([toolA, toolB]), false);
  assert.equal(prefix.fingerprint, f1);
  assert.equal(prefix.setToolSpecs([toolA]), true);
  assert.notEqual(prefix.fingerprint, f1);
});

test('ImmutablePrefix.addTool / removeTool round-trip preserves fingerprint', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA] });
  const f1 = prefix.fingerprint;
  assert.equal(prefix.addTool(toolB), true);
  assert.notEqual(prefix.fingerprint, f1);
  assert.equal(prefix.removeTool('list_directory'), true);
  assert.equal(prefix.fingerprint, f1);
});

test('ImmutablePrefix.addTool ignores duplicate by name', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA] });
  assert.equal(prefix.addTool(toolA), false);
  assert.equal(prefix.toolSpecs.length, 1);
});

test('ImmutablePrefix.setAnchors signals change and updates fingerprint', () => {
  const prefix = new ImmutablePrefix({ system: 'sys' });
  const f1 = prefix.fingerprint;
  const anchor: ChatMessage = { role: 'assistant', content: '[memory] rec_001 …' };
  assert.equal(prefix.setAnchors([anchor]), true);
  assert.notEqual(prefix.fingerprint, f1);
  assert.equal(prefix.setAnchors([anchor]), false);
});

test('ImmutablePrefix.toMessages returns system + anchors + few-shots in order', () => {
  const anchor: ChatMessage = { role: 'assistant', content: 'anchor-1' };
  const shot: ChatMessage = { role: 'user', content: 'shot-1' };
  const prefix = new ImmutablePrefix({ system: 'sys', anchors: [anchor], fewShots: [shot] });
  const msgs = prefix.toMessages();
  assert.deepEqual(
    msgs.map(m => `${m.role}:${m.content}`),
    ['system:sys', 'assistant:anchor-1', 'user:shot-1'],
  );
});

test('ImmutablePrefix.tools() returns a deep copy', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA] });
  const tools = prefix.tools();
  tools[0]!.function.name = 'mutated';
  // The original is unaffected.
  assert.equal(prefix.toolSpecs[0]!.function.name, 'read_file');
});

test('ImmutablePrefix.verifyFingerprint catches uncached drift', () => {
  const prefix = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA] });
  // Force the cached fingerprint to be set.
  void prefix.fingerprint;
  // Reach into the field to simulate a path that bypassed the public setters.
  (prefix as any)._system = 'sys-bypass';
  assert.throws(() => prefix.verifyFingerprint(), /fingerprint drift/);
});

test('AppendOnlyLog appends in order and exposes a copy via toMessages', () => {
  const log = new AppendOnlyLog();
  log.append({ role: 'user', content: 'hi' });
  log.append({ role: 'assistant', content: 'hello' });
  const msgs = log.toMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.content, 'hi');
  // Mutating the copy must not change the log.
  msgs[0]!.content = 'bypassed';
  assert.equal(log.entries[0]!.content, 'hi');
});

test('AppendOnlyLog.append rejects invalid entries', () => {
  const log = new AppendOnlyLog();
  assert.throws(() => log.append(null as any), /invalid log entry/);
  assert.throws(() => log.append({} as any), /invalid log entry/);
});

test('AppendOnlyLog.compactInPlace replaces the whole log', () => {
  const log = new AppendOnlyLog();
  log.append({ role: 'user', content: 'a' });
  log.append({ role: 'user', content: 'b' });
  log.compactInPlace([{ role: 'system', content: 'compact summary' }]);
  assert.equal(log.length, 1);
  assert.equal(log.entries[0]!.role, 'system');
});

test('VolatileScratch.reset clears reasoning + plan + notes', () => {
  const scratch = new VolatileScratch();
  scratch.reasoning = 'long chain of thought';
  scratch.planState = { step: 1 };
  scratch.notes.push('note-1');
  scratch.reset();
  assert.equal(scratch.reasoning, null);
  assert.equal(scratch.planState, null);
  assert.deepEqual(scratch.notes, []);
});

test('ContextRegions.toMessages prepends prefix and appends log entries', () => {
  const regions = new ContextRegions({ system: 'sys', toolSpecs: [toolA] });
  regions.log.append({ role: 'user', content: 'turn-1' });
  regions.log.append({ role: 'assistant', content: 'reply-1' });
  const msgs = regions.toMessages();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]!.role, 'system');
  assert.equal(msgs[1]!.content, 'turn-1');
  assert.equal(msgs[2]!.content, 'reply-1');
});

test('ContextRegions.prefixFingerprint matches the wrapped prefix', () => {
  const regions = new ContextRegions({ system: 'sys', toolSpecs: [toolA] });
  assert.equal(regions.prefixFingerprint, regions.prefix.fingerprint);
});

test('ImmutablePrefix anchor list participates in the fingerprint', () => {
  const a = new ImmutablePrefix({ system: 'sys', anchors: [{ role: 'assistant', content: 'a' }] });
  const b = new ImmutablePrefix({ system: 'sys', anchors: [{ role: 'assistant', content: 'b' }] });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('ImmutablePrefix tool order matters for the fingerprint', () => {
  const a = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolA, toolB] });
  const b = new ImmutablePrefix({ system: 'sys', toolSpecs: [toolB, toolA] });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

// ---- computePrefixFingerprint (standalone helper for the LLM boundary) -----

import { computePrefixFingerprint } from '../runtime/contextRegions.js';

test('computePrefixFingerprint ignores the append-only log slice', () => {
  const stable: ChatMessage[] = [
    { role: 'system', content: 'sys' },
  ];
  const f1 = computePrefixFingerprint(stable, [toolA]);
  const withLog: ChatMessage[] = [
    ...stable,
    { role: 'user', content: 'turn-1' },
    { role: 'assistant', content: 'reply-1' },
  ];
  const f2 = computePrefixFingerprint(withLog, [toolA]);
  assert.equal(f1, f2);
});

test('computePrefixFingerprint folds pinned (meta.pinned) messages into the prefix', () => {
  const withoutAnchor = [{ role: 'system', content: 'sys' } as ChatMessage];
  const withAnchor: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '[memory] rec_001 …', meta: { pinned: true } },
  ];
  assert.notEqual(
    computePrefixFingerprint(withoutAnchor, [toolA]),
    computePrefixFingerprint(withAnchor, [toolA]),
  );
});

test('computePrefixFingerprint accepts both MCP and OpenAI tool shapes equivalently', () => {
  const mcp = [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }];
  const openai = [{ type: 'function' as const, function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }];
  const stable: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  assert.equal(
    computePrefixFingerprint(stable, mcp as any),
    computePrefixFingerprint(stable, openai),
  );
});

test('computePrefixFingerprint changes when the system prompt changes', () => {
  const a: ChatMessage[] = [{ role: 'system', content: 'sys-a' }];
  const b: ChatMessage[] = [{ role: 'system', content: 'sys-b' }];
  assert.notEqual(
    computePrefixFingerprint(a, [toolA]),
    computePrefixFingerprint(b, [toolA]),
  );
});
