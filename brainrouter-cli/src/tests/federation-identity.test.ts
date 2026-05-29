import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFederationIdentity } from '../runtime/federationIdentity.js';

const FED = 'fed-uuid-1234';

test('session_inbox_read: forces sessionKey to the federation key (overrides the chat key)', () => {
  const out = applyFederationIdentity('session_inbox_read', { sessionKey: 'chat-key', peek: true }, FED) as any;
  assert.equal(out.sessionKey, FED);
  assert.equal(out.peek, true); // other args preserved
});

test('session_inbox_read: injects sessionKey when the agent omitted it', () => {
  const out = applyFederationIdentity('session_inbox_read', {}, FED) as any;
  assert.equal(out.sessionKey, FED);
});

test('session_inbox_ack: forces sessionKey to the federation key', () => {
  const out = applyFederationIdentity('session_inbox_ack', { sessionKey: 'chat-key', ids: ['m1'] }, FED) as any;
  assert.equal(out.sessionKey, FED);
  assert.deepEqual(out.ids, ['m1']);
});

test('session_send: forces `from` but leaves `to` untouched', () => {
  const out = applyFederationIdentity(
    'session_send',
    { from: 'chat-key', to: 'peer-key', kind: 'text', payload: { text: 'hi' } },
    FED,
  ) as any;
  assert.equal(out.from, FED);
  assert.equal(out.to, 'peer-key');
  assert.equal(out.payload.text, 'hi');
});

test('matches pool-normalised names (mcp_<server>_session_inbox_read)', () => {
  const out = applyFederationIdentity('mcp_brainrouter_session_inbox_read', { sessionKey: 'chat' }, FED) as any;
  assert.equal(out.sessionKey, FED);
});

test('non-federation tools pass through untouched', () => {
  const args = { sessionKey: 'chat-key', query: 'x' };
  const out = applyFederationIdentity('memory_recall', args, FED);
  assert.equal(out, args); // same reference — no rewrite
});

test('no-op when federation is not attached (null key)', () => {
  const args = { sessionKey: 'chat-key' };
  assert.equal(applyFederationIdentity('session_inbox_read', args, null), args);
  assert.equal(applyFederationIdentity('session_inbox_read', args, undefined), args);
  assert.equal(applyFederationIdentity('session_inbox_read', args, ''), args);
});
