import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTranscriptEntry, forkSession, loadTranscript } from '../session/sessionStore.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fork-'));
const t1 = '2026-06-10T00:00:01.000Z';
const t2 = '2026-06-10T00:00:02.000Z';
const t3 = '2026-06-10T00:00:03.000Z';

function seed(ws: string, key: string): void {
  appendTranscriptEntry(ws, key, { role: 'user', content: 'a', timestamp: t1 });
  appendTranscriptEntry(ws, key, { role: 'assistant', content: 'b', timestamp: t2 });
  appendTranscriptEntry(ws, key, { role: 'user', content: 'c', timestamp: t3 });
}

test('forkSession (no cut) copies the WHOLE conversation', () => {
  const ws = tmpWs();
  seed(ws, 'sess:orig');
  const forkKey = forkSession(ws, 'sess:orig');
  assert.ok(forkKey && forkKey.startsWith('sess:fork-'));
  assert.equal(loadTranscript(ws, forkKey!).length, 3);
});

test('DESK-6v forkSession (upToTs) branches at a message — keeps entries at/before it, drops after', () => {
  const ws = tmpWs();
  seed(ws, 'sess:orig');
  const forkKey = forkSession(ws, 'sess:orig', Date.parse(t2)); // branch at "b"
  const entries = loadTranscript(ws, forkKey!);
  assert.equal(entries.length, 2, 'kept a + b, dropped c');
  assert.deepEqual(entries.map((e) => e.content), ['a', 'b']);
});

test('forkSession returns null when the source has no transcript', () => {
  assert.equal(forkSession(tmpWs(), 'sess:nope'), null);
});
