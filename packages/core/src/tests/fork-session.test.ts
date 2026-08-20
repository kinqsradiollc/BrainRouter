import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendTranscriptEntry,
  forkSession,
  loadTranscript,
  listTranscripts,
  readSessionLineage,
} from '../session/transcript/sessionStore.js';

/** The persisted bucket dir for a session, via its list summary. */
function dirOf(ws: string, key: string): string {
  const dir = listTranscripts(ws).find((s) => s.sessionKey === key)?.sessionDir;
  assert.ok(dir, `session ${key} has a bucket dir`);
  return dir!;
}

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

test('A41-14 — a whole-conversation fork records lineage (parent + forkedAt, no cut)', () => {
  const ws = tmpWs();
  seed(ws, 'sess:orig');
  const forkKey = forkSession(ws, 'sess:orig')!;
  const lineage = readSessionLineage(dirOf(ws, forkKey));
  assert.ok(lineage, 'fork has a lineage record');
  assert.equal(lineage!.parentSessionKey, 'sess:orig');
  assert.equal(typeof lineage!.forkedAt, 'string');
  assert.equal(lineage!.branchedAtTs, undefined, 'whole-conversation fork has no branch point');
});

test('A41-14 — a mid-conversation fork records the branch point', () => {
  const ws = tmpWs();
  seed(ws, 'sess:orig');
  const cut = Date.parse(t2);
  const forkKey = forkSession(ws, 'sess:orig', cut)!;
  const lineage = readSessionLineage(dirOf(ws, forkKey));
  assert.equal(lineage!.parentSessionKey, 'sess:orig');
  assert.equal(lineage!.branchedAtTs, cut);
});

test('A41-14 — a root session has no lineage; the fork surfaces parentSessionKey in the session list', () => {
  const ws = tmpWs();
  seed(ws, 'sess:orig');
  const forkKey = forkSession(ws, 'sess:orig')!;
  // Root session: no lineage record.
  assert.equal(readSessionLineage(dirOf(ws, 'sess:orig')), null);
  // The fork's summary carries the parent; the root's does not.
  const summaries = listTranscripts(ws);
  const forkSummary = summaries.find((s) => s.sessionKey === forkKey);
  const rootSummary = summaries.find((s) => s.sessionKey === 'sess:orig');
  assert.equal(forkSummary?.parentSessionKey, 'sess:orig');
  assert.equal(rootSummary?.parentSessionKey, undefined);
});
