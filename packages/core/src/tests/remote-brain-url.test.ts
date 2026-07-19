/**
 * `isRemoteBrainUrl` gates local-desktop control (browser_* / computer_use).
 * A LOOPBACK brain is the same host as the desktop — same trust boundary as the
 * embedded brain — so it must NOT count as remote, or the standard dockerized
 * local stack (brain at http://localhost:3747/mcp) silently loses every browser
 * and computer tool. A genuinely remote brain must still be blocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRemoteBrainUrl } from '../config/config.js';

test('unset/empty brainUrl is local (embedded)', () => {
  assert.equal(isRemoteBrainUrl(null), false);
  assert.equal(isRemoteBrainUrl(undefined), false);
  assert.equal(isRemoteBrainUrl(''), false);
  assert.equal(isRemoteBrainUrl('   '), false);
});

test('loopback brains are NOT remote — local desktop control stays available', () => {
  assert.equal(isRemoteBrainUrl('http://localhost:3747/mcp'), false);
  assert.equal(isRemoteBrainUrl('http://127.0.0.1:3747/mcp'), false);
  assert.equal(isRemoteBrainUrl('http://127.5.5.5:8080'), false); // all of 127.0.0.0/8
  assert.equal(isRemoteBrainUrl('http://[::1]:3747/mcp'), false);
  assert.equal(isRemoteBrainUrl('http://api.localhost/mcp'), false);
});

test('genuinely remote brains ARE remote — local desktop control blocked', () => {
  assert.equal(isRemoteBrainUrl('https://brain.company.com/mcp'), true);
  assert.equal(isRemoteBrainUrl('http://192.168.1.20:3747/mcp'), true); // LAN, not loopback
  assert.equal(isRemoteBrainUrl('http://host.docker.internal:3747/mcp'), true);
});

test('unparseable brainUrl is treated as remote (never grant control on an unvetted URL)', () => {
  assert.equal(isRemoteBrainUrl('not a url'), true);
  assert.equal(isRemoteBrainUrl('localhost:3747'), true); // no scheme → not a valid URL
});
