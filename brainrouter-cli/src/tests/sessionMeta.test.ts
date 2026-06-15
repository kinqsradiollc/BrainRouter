import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setSessionMeta, getSessionMeta, removeSessionMeta, listSessionGroups, readSessionMetaAll,
} from '../state/sessionMetaStore.js';
import { appendTranscriptEntry, listTranscripts, deleteSession, forkSession, readTranscriptEntries } from '../state/sessionStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('DESK-6m sessionMeta: set merges + prunes defaults; remove clears', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    setSessionMeta(ws, 'k:1', { pinned: true, title: 'My chat' });
    assert.deepEqual(getSessionMeta(ws, 'k:1'), { pinned: true, title: 'My chat' });
    // a merge that flips pinned off + sets completed; 'active' and false are pruned.
    setSessionMeta(ws, 'k:1', { pinned: false, status: 'completed' });
    assert.deepEqual(getSessionMeta(ws, 'k:1'), { title: 'My chat', status: 'completed' });
    setSessionMeta(ws, 'k:1', { status: 'active', title: '' }); // both prune away
    assert.deepEqual(getSessionMeta(ws, 'k:1'), {});
    assert.deepEqual(readSessionMetaAll(ws), {}, 'fully-default entry is dropped from the file');

    setSessionMeta(ws, 'k:2', { archived: true });
    removeSessionMeta(ws, 'k:2');
    assert.deepEqual(getSessionMeta(ws, 'k:2'), {});
  });
});

test('DESK-6m sessionMeta: listSessionGroups returns distinct, sorted groups', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    setSessionMeta(ws, 'a', { group: 'Work' });
    setSessionMeta(ws, 'b', { group: 'Personal' });
    setSessionMeta(ws, 'c', { group: 'Work' });
    setSessionMeta(ws, 'd', { pinned: true }); // ungrouped
    assert.deepEqual(listSessionGroups(ws), ['Personal', 'Work']);
  });
});

test('DESK-6m fork duplicates the transcript to a new key; delete removes it', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    appendTranscriptEntry(ws, 'chat:orig', { role: 'user', content: 'hello there' });
    appendTranscriptEntry(ws, 'chat:orig', { role: 'assistant', content: 'hi!' });

    const forkKey = forkSession(ws, 'chat:orig');
    assert.ok(forkKey && forkKey.startsWith('chat:fork-'), 'fork key under the same prefix');
    const forked = readTranscriptEntries(ws, forkKey!, 40);
    assert.equal(forked.length, 2, 'fork has a copy of the transcript');
    assert.equal((forked[0] as { content?: string }).content, 'hello there');

    // original untouched; deleting the fork leaves the original.
    assert.ok(listTranscripts(ws).some((s) => s.sessionKey === 'chat:orig'));
    assert.equal(deleteSession(ws, forkKey!), true);
    assert.ok(!listTranscripts(ws).some((s) => s.sessionKey === forkKey));
    assert.ok(listTranscripts(ws).some((s) => s.sessionKey === 'chat:orig'), 'original survives');
  });
});
