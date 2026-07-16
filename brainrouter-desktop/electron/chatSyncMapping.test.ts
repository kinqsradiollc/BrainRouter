import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEntry } from '@kinqs/brainrouter-core/session';
import {
  deriveThreadTitle,
  emptyMapping,
  getThreadLink,
  isSafeSessionKey,
  mappingKey,
  normalizeMapping,
  removeThreadLink,
  transcriptEntriesToServerMessages,
  upsertThreadLink,
} from './chatSyncMapping.js';

function entry(e: Partial<TranscriptEntry> & { role: string }): TranscriptEntry {
  return { timestamp: '2026-07-16T00:00:00.000Z', ...e };
}

test('transcriptEntriesToServerMessages keeps only non-empty user/assistant text turns, in order', () => {
  const entries: TranscriptEntry[] = [
    entry({ role: 'user', content: '  hello  ' }),
    entry({ role: 'assistant', content: 'hi there' }),
    entry({ role: 'tool', content: 'tool output' }),
    entry({ role: 'system', content: 'system note' }),
    entry({ role: 'user', name: 'guard', content: 'injected guardrail' }),
    entry({ role: 'assistant', content: '   ' }),
    entry({ role: 'assistant', tool_calls: [{ id: 'c1' }] }), // tool-call-only, no string content
    entry({ role: 'assistant', content: { blocks: [] } as unknown }), // non-string content
    entry({ role: 'user', content: 'second prompt' }),
  ];
  assert.deepEqual(transcriptEntriesToServerMessages(entries), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'second prompt' },
  ]);
});

test('transcriptEntriesToServerMessages returns [] when nothing is pushable', () => {
  const entries: TranscriptEntry[] = [
    entry({ role: 'tool', content: 'x' }),
    entry({ role: 'user', name: 'guard', content: 'g' }),
    entry({ role: 'assistant', content: '' }),
  ];
  assert.deepEqual(transcriptEntriesToServerMessages(entries), []);
});

test('deriveThreadTitle uses the first real user prompt, collapsed and capped', () => {
  const long = 'w'.repeat(200);
  const entries: TranscriptEntry[] = [
    entry({ role: 'assistant', content: 'greeting first' }),
    entry({ role: 'user', name: 'guard', content: 'skip me' }),
    entry({ role: 'user', content: `  fix   the\n\tbug ${long}` }),
  ];
  const title = deriveThreadTitle(entries);
  assert.equal(title.length, 120);
  assert.ok(title.startsWith('fix the bug w'));
});

test('deriveThreadTitle falls back to the default when there is no real user prompt', () => {
  assert.equal(deriveThreadTitle([entry({ role: 'assistant', content: 'hi' })]), 'Desktop session');
  assert.equal(deriveThreadTitle([], 'Custom'), 'Custom');
});

test('upsert/get/remove thread links are immutable and scoped by workspace+session', () => {
  const link = { threadId: 'ct_1', syncedAt: '2026-07-16T00:00:00.000Z', messageCount: 3 };
  const base = emptyMapping();
  const m1 = upsertThreadLink(base, '/ws/a', 'chat:1', link);

  // original untouched (pure)
  assert.deepEqual(base.threads, {});
  assert.deepEqual(getThreadLink(m1, '/ws/a', 'chat:1'), link);

  // same sessionKey in a different workspace does NOT collide
  assert.equal(getThreadLink(m1, '/ws/b', 'chat:1'), undefined);
  const m2 = upsertThreadLink(m1, '/ws/b', 'chat:1', { ...link, threadId: 'ct_2' });
  assert.equal(getThreadLink(m2, '/ws/a', 'chat:1')?.threadId, 'ct_1');
  assert.equal(getThreadLink(m2, '/ws/b', 'chat:1')?.threadId, 'ct_2');

  // re-push replaces the same link in place (no duplicate key)
  const m3 = upsertThreadLink(m2, '/ws/a', 'chat:1', { ...link, threadId: 'ct_1', messageCount: 9 });
  assert.equal(Object.keys(m3.threads).length, 2);
  assert.equal(getThreadLink(m3, '/ws/a', 'chat:1')?.messageCount, 9);

  // removal drops only the targeted link, immutably
  const m4 = removeThreadLink(m3, '/ws/a', 'chat:1');
  assert.equal(getThreadLink(m4, '/ws/a', 'chat:1'), undefined);
  assert.equal(getThreadLink(m4, '/ws/b', 'chat:1')?.threadId, 'ct_2');
  assert.equal(getThreadLink(m3, '/ws/a', 'chat:1')?.threadId, 'ct_1'); // m3 unchanged
  assert.equal(removeThreadLink(m3, '/ws/a', 'missing'), m3); // no-op returns same ref
});

test('mappingKey separates workspace from session unambiguously', () => {
  assert.notEqual(mappingKey('/ws/a', 'chat:1'), mappingKey('/ws/a:chat', '1'));
});

test('normalizeMapping tolerates junk and drops malformed rows', () => {
  assert.deepEqual(normalizeMapping(null), emptyMapping());
  assert.deepEqual(normalizeMapping('nope'), emptyMapping());
  assert.deepEqual(normalizeMapping({ threads: 42 }), emptyMapping());
  const normalized = normalizeMapping({
    threads: {
      good: { threadId: 'ct_9', syncedAt: 'ts', messageCount: 2 },
      noId: { syncedAt: 'ts', messageCount: 1 },
      badShape: 'string',
      partial: { threadId: 'ct_10' },
    },
  });
  assert.deepEqual(Object.keys(normalized.threads).sort(), ['good', 'partial']);
  assert.deepEqual(normalized.threads.partial, { threadId: 'ct_10', syncedAt: '', messageCount: 0 });
});

test('isSafeSessionKey accepts opaque tokens and rejects path/traversal chars', () => {
  for (const ok of ['chat:main', 'chat:fork-1a2b3c4d', 'session_key-1', 'ABC123']) {
    assert.equal(isSafeSessionKey(ok), true, ok);
  }
  for (const bad of ['../etc/passwd', 'a/b', 'a\\b', 'has space', 'dot.dot', '', 42, null, undefined]) {
    assert.equal(isSafeSessionKey(bad as unknown), false, String(bad));
  }
});
