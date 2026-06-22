import test from 'node:test';
import assert from 'node:assert/strict';
import { pickResumeSession } from '../state/resumePicker.js';
import type { TranscriptSummary } from '@kinqs/brainrouter-core/dist/session/sessionStore.js';

const T = (sessionKey: string, modifiedAt: string): TranscriptSummary =>
  ({ sessionKey, modifiedAt, turnCount: 3, firstUserMessage: 'x' } as TranscriptSummary);

// newest-first, mirroring listTranscripts' sort
const TRANSCRIPTS: TranscriptSummary[] = [
  T('sess-ccc:worker:wkr_9', '2026-06-10T05:00:00Z'),
  T('sess-bbb', '2026-06-10T04:00:00Z'),
  T('sess-aaa', '2026-06-09T01:00:00Z'),
  T('sess-aab', '2026-06-08T01:00:00Z'),
];

test('--continue picks the newest NON-worker session', () => {
  const r = pickResumeSession(TRANSCRIPTS, { continueLatest: true });
  assert.deepEqual(r, { ok: true, sessionKey: 'sess-bbb' });
});

test('--continue with only worker transcripts → error', () => {
  const r = pickResumeSession([T('x:worker:w1', '2026-06-10T05:00:00Z')], { continueLatest: true });
  assert.equal(r.ok, false);
});

test('--resume exact key wins', () => {
  assert.deepEqual(pickResumeSession(TRANSCRIPTS, { resumeKey: 'sess-aaa' }), { ok: true, sessionKey: 'sess-aaa' });
});

test('--resume unique prefix resolves; ambiguous prefix errors', () => {
  assert.deepEqual(pickResumeSession(TRANSCRIPTS, { resumeKey: 'sess-b' }), { ok: true, sessionKey: 'sess-bbb' });
  const ambiguous = pickResumeSession(TRANSCRIPTS, { resumeKey: 'sess-aa' });
  assert.equal(ambiguous.ok, false);
  assert.match((ambiguous as { error: string }).error, /matches 2 sessions/);
});

test('--resume unknown key errors with guidance', () => {
  const r = pickResumeSession(TRANSCRIPTS, { resumeKey: 'nope' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /matches no persisted session/);
});

test('no flags → not-ok result', () => {
  assert.equal(pickResumeSession(TRANSCRIPTS, {}).ok, false);
});
