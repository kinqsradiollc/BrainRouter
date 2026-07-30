import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry } from '@kinqs/brainrouter-core/session';
import {
  deriveThreadTitle,
  transcriptEntriesToServerMessages,
} from '../runtime/chatSync/transcriptMapping.js';
import {
  emptyMapping,
  getThreadLink,
  loadIdMapping,
  saveIdMapping,
  upsertThreadLink,
  type ChatSyncMapping,
} from '../runtime/chatSync/idMapping.js';

function entry(overrides: Partial<TranscriptEntry> & { role: string }): TranscriptEntry {
  return { timestamp: '2026-07-16T00:00:00.000Z', ...overrides };
}

test('transcriptEntriesToServerMessages keeps only user/assistant text turns, in order', () => {
  const entries: TranscriptEntry[] = [
    entry({ role: 'user', content: 'hello there' }),
    entry({ role: 'assistant', content: 'hi! how can I help?' }),
    entry({ role: 'user', content: '  fix the bug  ' }),
    entry({ role: 'assistant', content: 'on it' }),
  ];
  assert.deepEqual(transcriptEntriesToServerMessages(entries), [
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: 'hi! how can I help?' },
    { role: 'user', content: 'fix the bug' }, // trimmed
    { role: 'assistant', content: 'on it' },
  ]);
});

test('transcriptEntriesToServerMessages drops tool/guard/non-string/empty entries', () => {
  const entries: TranscriptEntry[] = [
    entry({ role: 'system', content: 'you are an agent' }),                 // not user/assistant
    entry({ role: 'tool', content: '{"result":42}', tool_call_id: 'c1' }), // tool result
    entry({ role: 'user', name: 'guard', content: '[guard] be careful' }), // injected guard (has name)
    entry({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] }), // tool-call-only turn (empty content)
    entry({ role: 'user', content: '   ' }),                                // whitespace only
    entry({ role: 'assistant', content: { text: 'structured' } as unknown }), // non-string content
    entry({ role: 'user', content: 'a real question' }),
  ];
  assert.deepEqual(transcriptEntriesToServerMessages(entries), [
    { role: 'user', content: 'a real question' },
  ]);
});

test('transcriptEntriesToServerMessages returns [] for a transcript with no conversational turns', () => {
  const entries: TranscriptEntry[] = [
    entry({ role: 'tool', content: 'x', tool_call_id: 'c1' }),
    entry({ role: 'system', content: 'sys' }),
  ];
  assert.deepEqual(transcriptEntriesToServerMessages(entries), []);
});

test('deriveThreadTitle uses the first real user prompt, collapsed and capped', () => {
  const title = deriveThreadTitle([
    entry({ role: 'user', name: 'guard', content: 'guard note' }),         // skipped (has name)
    entry({ role: 'assistant', content: 'hello' }),                         // skipped (not user)
    entry({ role: 'user', content: '  Refactor   the\nrecall\tpipeline  ' }),
  ]);
  assert.equal(title, 'Refactor the recall pipeline');
});

test('deriveThreadTitle caps at 120 chars', () => {
  const long = 'x'.repeat(500);
  const title = deriveThreadTitle([entry({ role: 'user', content: long })]);
  assert.equal(title.length, 120);
});

test('deriveThreadTitle falls back when there is no user prompt', () => {
  assert.equal(deriveThreadTitle([entry({ role: 'assistant', content: 'hi' })]), 'CLI session');
  assert.equal(deriveThreadTitle([], 'Custom'), 'Custom');
});

test('upsertThreadLink is a pure, immutable upsert', () => {
  const base = emptyMapping();
  const one = upsertThreadLink(base, 'session:a', { threadId: 'ct_1', syncedAt: 't1', messageCount: 3 });
  // Original untouched.
  assert.deepEqual(base.threads, {});
  assert.notEqual(one, base);
  assert.deepEqual(getThreadLink(one, 'session:a'), { threadId: 'ct_1', syncedAt: 't1', messageCount: 3 });

  // A second session is added without dropping the first.
  const two = upsertThreadLink(one, 'session:b', { threadId: 'ct_2', syncedAt: 't2', messageCount: 5 });
  assert.equal(getThreadLink(two, 'session:a')?.threadId, 'ct_1');
  assert.equal(getThreadLink(two, 'session:b')?.threadId, 'ct_2');

  // Re-pushing the same session REPLACES its link (dedupe), not appends.
  const three = upsertThreadLink(two, 'session:a', { threadId: 'ct_1', syncedAt: 't3', messageCount: 9 });
  assert.equal(Object.keys(three.threads).length, 2);
  assert.deepEqual(getThreadLink(three, 'session:a'), { threadId: 'ct_1', syncedAt: 't3', messageCount: 9 });
});

test('loadIdMapping/saveIdMapping round-trips through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sync-map-'));
  const file = path.join(dir, 'chat-sync-threads.json');
  try {
    // Missing file → empty mapping.
    assert.deepEqual(loadIdMapping(file), emptyMapping());

    const mapping: ChatSyncMapping = upsertThreadLink(emptyMapping(), 'session:x', {
      threadId: 'ct_x', syncedAt: '2026-07-16T00:00:00.000Z', messageCount: 4,
    });
    saveIdMapping(file, mapping);
    assert.deepEqual(loadIdMapping(file), mapping);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIdMapping tolerates malformed / wrong-shaped files without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sync-map-'));
  const file = path.join(dir, 'chat-sync-threads.json');
  try {
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    assert.deepEqual(loadIdMapping(file), emptyMapping());

    // Well-formed json, junk rows are dropped; a valid row survives.
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      threads: {
        good: { threadId: 'ct_ok', syncedAt: 't', messageCount: 2 },
        noId: { syncedAt: 't', messageCount: 1 },
        notObject: 'nope',
      },
    }), 'utf8');
    const loaded = loadIdMapping(file);
    assert.deepEqual(Object.keys(loaded.threads), ['good']);
    assert.equal(getThreadLink(loaded, 'good')?.threadId, 'ct_ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
