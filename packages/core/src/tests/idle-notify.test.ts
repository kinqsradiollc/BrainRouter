/**
 * ADR-052 P4.2 — one-shot notify-when-idle. The store records a subscription and
 * drains it exactly once on the watched session's idle; the `notify_when_idle`
 * builtin tool subscribes the current session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subscribeIdleNotice, drainIdleNotices } from '../session/messaging/idleNotifyStore.js';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';
import { registryToolAllowed } from '../tool/registry/registry.js';

function ws(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'idle-notify-')); }

test('subscribe records a one-shot; drain returns the requesters once, then nothing', () => {
  const root = ws();
  try {
    assert.equal(subscribeIdleNotice(root, 'sess:watched', 'sess:a', 1), true);
    assert.equal(subscribeIdleNotice(root, 'sess:watched', 'sess:b', 2), true);
    assert.equal(subscribeIdleNotice(root, 'sess:watched', 'sess:a', 3), true); // idempotent
    const first = drainIdleNotices(root, 'sess:watched').sort();
    assert.deepEqual(first, ['sess:a', 'sess:b'], 'both subscribers, de-duplicated');
    assert.deepEqual(drainIdleNotices(root, 'sess:watched'), [], 'one-shot — a second idle fires nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a self-subscription and an empty key are ignored', () => {
  const root = ws();
  try {
    assert.equal(subscribeIdleNotice(root, 'sess:x', 'sess:x', 1), false, 'self-subscription refused');
    assert.equal(subscribeIdleNotice(root, '', 'sess:a', 1), false);
    assert.deepEqual(drainIdleNotices(root, 'sess:x'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the notify_when_idle tool subscribes the current session; the drain would notify it', async () => {
  const root = ws();
  try {
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: root, sessionKey: 'sess:me' };
    const out = await invokeBuiltinToolRuntime.call(host, 'notify_when_idle', { target_session: 'sess:peer' });
    assert.match(out, /"subscribed":true/);
    assert.deepEqual(drainIdleNotices(root, 'sess:peer'), ['sess:me'], 'the watched peer would ping this session on idle');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notify_when_idle requires a target and rejects a self-target', async () => {
  const root = ws();
  try {
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: root, sessionKey: 'sess:me' };
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'notify_when_idle', {}), /requires target_session/);
    const selfOut = await invokeBuiltinToolRuntime.call(host, 'notify_when_idle', { target_session: 'sess:me' });
    assert.match(selfOut, /"subscribed":false/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notify_when_idle is a read-tier tool (available without write/shell access)', () => {
  assert.equal(registryToolAllowed('notify_when_idle', 'read'), true);
});
