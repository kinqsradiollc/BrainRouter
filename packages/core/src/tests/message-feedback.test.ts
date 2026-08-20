// ADR-041 A41-14 (W2) — per-message feedback store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordMessageFeedback,
  readMessageFeedback,
  messageFeedbackTally,
} from '../session/feedback/messageFeedback.js';
import { getSessionStateDir } from '../storage/store.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'msgfb-'));

test('A41-14 — records a rating + note and reads it back keyed by message timestamp', () => {
  const ws = tmpWs();
  assert.equal(recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'up', note: 'nailed it' }), true);
  const fb = readMessageFeedback(ws, 'sess:a');
  assert.equal(fb.size, 1);
  assert.equal(fb.get('t1')?.rating, 'up');
  assert.equal(fb.get('t1')?.note, 'nailed it');
  assert.equal(typeof fb.get('t1')?.at, 'string');
});

test('A41-14 — a re-rating edits in place (latest per message wins, append-only)', () => {
  const ws = tmpWs();
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'up', at: '2026-01-01T00:00:00.000Z' });
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'down', note: 'actually wrong', at: '2026-01-01T00:01:00.000Z' });
  const fb = readMessageFeedback(ws, 'sess:a');
  assert.equal(fb.size, 1, 'still one message, not two records');
  assert.equal(fb.get('t1')?.rating, 'down', 'the newer rating wins');
  assert.equal(fb.get('t1')?.note, 'actually wrong');
});

test('A41-14 — dropping a note on re-rating clears it (no stale note carried over)', () => {
  const ws = tmpWs();
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'down', note: 'bad' });
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'up' }); // no note now
  assert.equal(readMessageFeedback(ws, 'sess:a').get('t1')?.note, undefined);
});

test('A41-14 — feedback is per session and per message; tally counts standing ratings', () => {
  const ws = tmpWs();
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'up' });
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't2', rating: 'down' });
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't3', rating: 'up' });
  recordMessageFeedback(ws, 'sess:b', { messageTs: 't1', rating: 'down' }); // different session
  assert.deepEqual(messageFeedbackTally(ws, 'sess:a'), { up: 2, down: 1 });
  assert.deepEqual(messageFeedbackTally(ws, 'sess:b'), { up: 0, down: 1 });
});

test('A41-14 — a session with no feedback reads empty', () => {
  assert.equal(readMessageFeedback(tmpWs(), 'sess:none').size, 0);
  assert.deepEqual(messageFeedbackTally(tmpWs(), 'sess:none'), { up: 0, down: 0 });
});

test('A41-14 — malformed lines are skipped, valid ones survive', () => {
  const ws = tmpWs();
  recordMessageFeedback(ws, 'sess:a', { messageTs: 't1', rating: 'up' });
  // Corrupt the file with junk + a bad-rating record, then a good one.
  const file = path.join(getSessionStateDir(ws, 'sess:a'), 'message-feedback.jsonl');
  fs.appendFileSync(file, 'not json\n{"messageTs":"t2","rating":"sideways","at":"x"}\n{"messageTs":"t3","rating":"down","at":"2026-01-01T00:00:00.000Z"}\n');
  const fb = readMessageFeedback(ws, 'sess:a');
  assert.equal(fb.get('t1')?.rating, 'up');
  assert.equal(fb.has('t2'), false, 'invalid rating rejected');
  assert.equal(fb.get('t3')?.rating, 'down');
});
