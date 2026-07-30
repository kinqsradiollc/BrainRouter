import test from 'node:test';
import assert from 'node:assert/strict';
import { canRewindTo, entriesAfterRewind } from '../session/transcript/rewind.js';
import { appendTranscriptEntry, loadTranscript, rewindTranscript } from '../session/transcript/sessionStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// WS8 — "rewind to here": truncate the conversation to a point, UNLESS code was
// generated after it (then it's blocked and the UI shows an in-app warning).

const E = (role: string, extra: Record<string, unknown> = {}): any => ({ role, timestamp: '2026-06-22T00:00:00Z', ...extra });

test('WS8 canRewindTo: allowed when no code-gen tool ran after the target', () => {
  const entries = [E('user'), E('assistant'), E('tool', { name: 'read_file' }), E('assistant')];
  const r = canRewindTo(entries, 0);
  assert.equal(r.canRewind, true);
  assert.equal(r.codeActionsAfter, 0);
});

test('WS8 canRewindTo: BLOCKED when a write/edit/apply ran after the target', () => {
  const entries = [E('user'), E('assistant'), E('tool', { name: 'edit_file' }), E('assistant')];
  const r = canRewindTo(entries, 0);
  assert.equal(r.canRewind, false);
  assert.equal(r.codeActionsAfter, 1);
  assert.match(r.reason ?? '', /file change/);
});

test('WS8 canRewindTo: a FAILED code-gen tool does not block (no code produced)', () => {
  const entries = [E('user'), E('tool', { name: 'write_file', isError: true })];
  assert.equal(canRewindTo(entries, 0).canRewind, true);
});

test('WS8 canRewindTo: rewinding to the LAST entry is always allowed', () => {
  const entries = [E('user'), E('tool', { name: 'write_file' })];
  assert.equal(canRewindTo(entries, 1).canRewind, true);
});

test('WS8 entriesAfterRewind: keeps entries up to and including the target', () => {
  const entries = [E('user'), E('assistant'), E('user'), E('assistant')];
  assert.equal(entriesAfterRewind(entries, 1).length, 2);
});

test('WS8 rewindTranscript: truncates the file when allowed; refuses when code follows', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    appendTranscriptEntry(ws, 'chat:rw', { role: 'user', content: 'first' });
    appendTranscriptEntry(ws, 'chat:rw', { role: 'assistant', content: 'ok' });
    appendTranscriptEntry(ws, 'chat:rw', { role: 'user', content: 'second' });
    appendTranscriptEntry(ws, 'chat:rw', { role: 'assistant', content: 'done' });

    // Rewind to index 1 (keep the first two): allowed — nothing code-gen after.
    const r = rewindTranscript(ws, 'chat:rw', 1);
    assert.equal(r.ok, true);
    assert.equal(r.kept.length, 2);
    assert.equal(loadTranscript(ws, 'chat:rw').length, 2, 'file truncated to 2 entries');

    // Add a write_file result + a follow-up; rewinding before it is blocked.
    appendTranscriptEntry(ws, 'chat:rw', { role: 'tool', name: 'write_file', content: 'wrote app.ts' });
    appendTranscriptEntry(ws, 'chat:rw', { role: 'assistant', content: 'created the file' });
    const blocked = rewindTranscript(ws, 'chat:rw', 0);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? '', /orphan generated code/);
    assert.equal(loadTranscript(ws, 'chat:rw').length, 4, 'file unchanged when rewind is blocked');
  });
});
