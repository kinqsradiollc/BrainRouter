import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-home-')));
process.env.BRAINROUTER_HOME = HOME;

const { appendTranscriptEntry, readTranscriptEntries, readTranscriptTail, transcriptExists } =
  await import('@kinqs/brainrouter-core/dist/session/sessionStore.js');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-ws-')));
const KEY = 'sess:huge';

test('setup — write a large transcript (5000 entries + one 500KB tool result)', () => {
  for (let i = 0; i < 5000; i++) {
    appendTranscriptEntry(ws, KEY, { role: i % 2 ? 'assistant' : 'user', content: `msg ${i} ${'x'.repeat(80)}` });
  }
  appendTranscriptEntry(ws, KEY, { role: 'tool', name: 'run_command', content: 'Z'.repeat(500_000) });
  assert.ok(transcriptExists(ws, KEY));
});

test('readTranscriptTail returns ONLY the last maxEntries (bounded), newest last', () => {
  const tail = readTranscriptTail(ws, KEY, 400);
  assert.equal(tail.length, 400, 'capped to maxEntries');
  assert.equal(tail[tail.length - 1].role, 'tool', 'last entry is the most recent');
  assert.ok(
    !tail.some((e) => typeof e.content === 'string' && e.content.startsWith('msg 0 ')),
    'the OLDEST entry is not in the tail — proves it read the end, not the whole file',
  );
});

test('readTranscriptEntries uses the bounded tail reader for UI-sized limits', () => {
  const entries = readTranscriptEntries(ws, KEY, 3);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool']);
  assert.match(entries[0].content as string, /^msg 4998 /);
});

test('readTranscriptTail caps per-entry content so a giant tool result cannot bloat the payload', () => {
  const tail = readTranscriptTail(ws, KEY, 400, 50_000);
  const giant = tail.find((e) => e.role === 'tool');
  assert.ok(giant, 'giant entry present');
  const len = (giant!.content as string).length;
  assert.ok(len <= 50_200, `content capped (got ${len})`);
  assert.match(giant!.content as string, /truncated for display/);
});

test('readTranscriptTail with maxEntries beyond the file returns everything (no cap)', () => {
  const all = readTranscriptTail(ws, KEY, 100_000, 0);
  assert.equal(all.length, 5001);
});

test('transcriptExists is false for an unknown session (cheap, no read)', () => {
  assert.equal(transcriptExists(ws, 'sess:nope'), false);
});
