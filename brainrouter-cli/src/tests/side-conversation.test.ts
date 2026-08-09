import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTranscript } from '@kinqs/brainrouter-core/session';
import { createEphemeralSideAgent } from '../cli/commands/session/ephemeralSideAgent.js';
import { makeAgent, withTempWorkspace } from './_helpers.js';

test('side conversations isolate history, provenance, transcript, and learning', () => {
  withTempWorkspace((workspace) => {
    const parent = makeAgent(workspace);
    parent.sessionKey = 'main-session';
    parent.chatHistory.push(
      { role: 'user', content: 'main question' },
      { role: 'assistant', content: 'main answer' },
    );
    parent.sessionProvenance.untrustedReads = 1;

    const parentHistory = structuredClone(parent.chatHistory);
    const side = createEphemeralSideAgent(parent, 'main-session:side:test');

    assert.equal(parent.sessionKey, 'main-session');
    assert.equal(side.sessionKey, 'main-session:side:test');
    assert.equal(side.silent, true);
    assert.equal(side.learningEnabled, false);
    assert.equal(side.enableRecall, false);
    assert.equal(side.sessionProvenance.untrustedReads, 0);
    assert.deepEqual(
      side.chatHistory.slice(1),
      parent.chatHistory.filter((message) => ['user', 'assistant', 'tool'].includes(message.role)),
    );

    side.chatHistory.push({ role: 'user', content: 'side-only prompt' });
    side.sessionProvenance.untrustedReads = 5;
    side.recordTranscript({ role: 'user', content: 'must not persist' });

    assert.deepEqual(parent.chatHistory, parentHistory);
    assert.equal(parent.sessionProvenance.untrustedReads, 1);
    assert.deepEqual(loadTranscript(workspace, side.sessionKey), []);
  });
});
