import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getLatestReview, saveReview, updateReviewFinding, clearReview } from '../review/reviewStore.js';
import { appendTranscriptEntry, isInternalSessionKey, listTranscripts } from '../session/transcript/sessionStore.js';
import type { ReviewRun } from '../review/reviewModel.js';

/** A real temp home AND a real temp workspace dir (getStateFile resolves the
 *  workspace path on disk, so it must exist). */
function withTemp(fn: (ws: string) => void): void {
  const prev = process.env.BRAINROUTER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ws-'));
  process.env.BRAINROUTER_HOME = home;
  try { fn(ws); } finally { if (prev === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prev; }
}

const mkRun = (ws: string): ReviewRun => ({
  id: 'r1', workspaceRoot: ws, repoRoot: ws, baseRef: 'HEAD', headRef: 'WT', diffHash: 'h1',
  createdAt: 't', updatedAt: 't', status: 'completed', summary: 's',
  findings: [{ id: 'f1', file: 'a.ts', severity: 'high', confidence: 90, summary: 'x', status: 'open', canApply: false, source: 'ai-review' }],
});

test('saveReview + getLatestReview round-trip per workspace', () => {
  withTemp((ws) => {
    assert.equal(getLatestReview(ws), null, 'no review initially');
    saveReview(ws, mkRun(ws));
    assert.equal(getLatestReview(ws)?.id, 'r1');
    assert.equal(getLatestReview(ws)?.findings[0].status, 'open');
  });
});

test('updateReviewFinding mutates a finding + persists', () => {
  withTemp((ws) => {
    saveReview(ws, mkRun(ws));
    assert.equal(updateReviewFinding(ws, 'f1', 'dismissed', 'later')?.findings[0].status, 'dismissed');
    assert.equal(getLatestReview(ws)?.findings[0].status, 'dismissed', 'persisted');
  });
});

test('updateReviewFinding on a missing run is a safe no-op', () => {
  withTemp((ws) => { assert.equal(updateReviewFinding(ws, 'f1', 'fixed', 't'), null); });
});

test('clearReview removes the run', () => {
  withTemp((ws) => { saveReview(ws, mkRun(ws)); clearReview(ws); assert.equal(getLatestReview(ws), null); });
});

test('isInternalSessionKey hides task/internal sessions only', () => {
  assert.equal(isInternalSessionKey('review:abc'), true);
  assert.equal(isInternalSessionKey('wshash:review:123'), true);
  assert.equal(isInternalSessionKey('internal:x'), true);
  assert.equal(isInternalSessionKey('wshash:internal:plan-revision:123'), true);
  assert.equal(isInternalSessionKey('fix:123'), true);
  assert.equal(isInternalSessionKey('wshash:fix:123'), true);
  assert.equal(isInternalSessionKey('wshash:parent:child:agent-123'), true);
  assert.equal(isInternalSessionKey('my-feature'), false);
  assert.equal(isInternalSessionKey('wshash:fix-the-bug'), false);
});

test('listTranscripts hides background task transcripts from the chat picker', () => {
  withTemp((ws) => {
    appendTranscriptEntry(ws, 'chat-1', { role: 'user', content: 'normal chat' });
    appendTranscriptEntry(ws, 'wshash:fix-the-bug', { role: 'user', content: 'normal fix chat' });
    appendTranscriptEntry(ws, 'review:abc', { role: 'user', content: 'review task' });
    appendTranscriptEntry(ws, 'internal:plan-revision:abc', { role: 'user', content: 'plan task' });
    appendTranscriptEntry(ws, 'fix:abc', { role: 'user', content: 'fix task' });
    appendTranscriptEntry(ws, 'chat-1:child:agent-abc', { role: 'user', content: 'child task' });

    const keys = listTranscripts(ws).map((s) => s.sessionKey).sort();
    assert.deepEqual(keys, ['chat-1', 'wshash:fix-the-bug']);
  });
});
