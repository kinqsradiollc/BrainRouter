// Unit tests for the pure saved-hosts list behind the connection manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addHost, removeHost } from './hosts.js';

test('addHost prepends, trims, and dedupes by url (most-recent first)', () => {
  let hosts = addHost([], 'ws://a:3747', 'tok');
  assert.deepEqual(hosts, [{ url: 'ws://a:3747', token: 'tok' }]);
  hosts = addHost(hosts, '  ws://b:3747  ');
  assert.deepEqual(hosts.map((h) => h.url), ['ws://b:3747', 'ws://a:3747']);
  hosts = addHost(hosts, 'ws://a:3747'); // re-adding moves it to the front (dedup)
  assert.deepEqual(hosts.map((h) => h.url), ['ws://a:3747', 'ws://b:3747']);
});

test('addHost ignores blank urls and normalizes an empty token to undefined', () => {
  assert.deepEqual(addHost([], '   '), []);
  assert.deepEqual(addHost([], 'ws://x:1', '   '), [{ url: 'ws://x:1', token: undefined }]);
});

test('removeHost drops the matching url and leaves the rest', () => {
  const hosts = [{ url: 'ws://a' }, { url: 'ws://b' }];
  assert.deepEqual(removeHost(hosts, 'ws://a'), [{ url: 'ws://b' }]);
  assert.deepEqual(removeHost(hosts, 'ws://nope'), hosts);
});
