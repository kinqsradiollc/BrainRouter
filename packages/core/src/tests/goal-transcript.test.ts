import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTranscriptEntry, listTranscripts } from '../session/sessionStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// WS4 — `/goal` records the goal text as an untagged user transcript entry the
// instant the goal is set. The sidebar lists a session only when its transcript
// exists, and titles it from the FIRST untagged user message. These tests pin
// the contract the fix relies on: the goal-text entry both lists and titles the
// session, and the (name-tagged) hidden kickoff turn that follows never steals
// the title.

test('WS4: an untagged user entry lists the session and becomes its title', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    appendTranscriptEntry(ws, 'chat:goal-1', { role: 'user', content: 'Ship the dark-mode toggle' });
    const summary = listTranscripts(ws).find((s) => s.sessionKey === 'chat:goal-1');
    assert.ok(summary, 'a session with a transcript is listed in the sidebar');
    assert.equal(summary?.firstUserMessage, 'Ship the dark-mode toggle', 'titled by the goal text');
  });
});

test('WS4: a name-tagged kickoff entry does not steal the goal-text title', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    // The order `/goal` writes them: goal text (untagged) FIRST, then the hidden kickoff.
    appendTranscriptEntry(ws, 'chat:goal-2', { role: 'user', content: 'Refactor the auth flow' });
    appendTranscriptEntry(ws, 'chat:goal-2', { role: 'user', content: '[GOAL KICKOFF — iteration 1] do X', name: 'goal' });
    const summary = listTranscripts(ws).find((s) => s.sessionKey === 'chat:goal-2');
    assert.equal(summary?.firstUserMessage, 'Refactor the auth flow', 'the untagged goal text wins the title');
  });
});

test('WS4: a session with ONLY a name-tagged kickoff is listed but not titled by it', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    appendTranscriptEntry(ws, 'chat:goal-3', { role: 'user', content: '[GOAL KICKOFF] do Y', name: 'goal' });
    const summary = listTranscripts(ws).find((s) => s.sessionKey === 'chat:goal-3');
    assert.ok(summary, 'still listed (the transcript exists)');
    assert.equal(summary?.firstUserMessage, undefined, 'a name-tagged entry never becomes the title');
  });
});
