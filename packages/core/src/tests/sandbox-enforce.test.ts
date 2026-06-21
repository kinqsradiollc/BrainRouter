import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { resolveSandboxConfig } from '../exec/sandbox.js';

/**
 * CODEX-SANDBOX-UNATTENDED — a silent / unattended agent (cloud worker,
 * spawned child) must be force-sandboxed even when `cli.sandbox` is off, with
 * network denied and a missing sandboxer failing closed. An operator can opt
 * out with `cli.sandboxEnforceWhenSilent: false`.
 *
 * Test bodies are SYNCHRONOUS on purpose: `resolveSandboxConfig` is sync, so a
 * non-async callback runs atomically and never interleaves its global knob
 * override with a sibling test (the race that flaked the hook tests).
 */

const WS = '/tmp/ws-sandbox-enforce';

test('config default: sandboxEnforceWhenSilent is true', () => {
  const resolved = resolveCliKnobs({ activeServer: '', servers: {} });
  assert.equal(resolved.sandboxEnforceWhenSilent, true);
});

test('silent + enforce(default) + sandbox off → forced on, network denied, fail-closed', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'off', sandboxNetwork: true, sandboxUnavailable: 'warn', sandboxEnforceWhenSilent: true });
  const cfg = resolveSandboxConfig(WS, {}, { silent: true });
  assert.equal(cfg.enabled, true, 'sandbox forced on for unattended agent');
  assert.equal(cfg.allowNetwork, false, 'network denied under enforcement (overrides sandboxNetwork:true)');
  assert.equal(cfg.unavailableMode, 'deny', 'missing sandboxer fails closed (overrides warn)');
  assert.equal(cfg.enforcedUnattended, true);
  _resetCliKnobsCache();
});

test('silent + enforce OFF + sandbox off → opt-out respected (unsandboxed)', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'off', sandboxEnforceWhenSilent: false });
  const cfg = resolveSandboxConfig(WS, {}, { silent: true });
  assert.equal(cfg.enabled, false, 'explicit opt-out lets unattended shells run unsandboxed');
  assert.equal(cfg.enforcedUnattended, false);
  _resetCliKnobsCache();
});

test('non-silent + sandbox off → enforcement does not apply (interactive)', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'off', sandboxEnforceWhenSilent: true });
  const cfg = resolveSandboxConfig(WS, {}, { silent: false });
  assert.equal(cfg.enabled, false, 'interactive run honors cli.sandbox=off');
  assert.equal(cfg.enforcedUnattended, false);
  _resetCliKnobsCache();
});

test('silent + sandbox on + network on → enforcement still denies network', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'on', sandboxNetwork: true, sandboxEnforceWhenSilent: true });
  const cfg = resolveSandboxConfig(WS, {}, { silent: true });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.allowNetwork, false, 'unattended enforcement clamps network even when sandbox is explicitly on');
  assert.equal(cfg.enforcedUnattended, true);
  _resetCliKnobsCache();
});

test('non-silent + sandbox on + network on → user settings preserved', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'on', sandboxNetwork: true, sandboxEnforceWhenSilent: true });
  const cfg = resolveSandboxConfig(WS, {}, { silent: false });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.allowNetwork, true, 'interactive run keeps the user-chosen network setting');
  assert.equal(cfg.enforcedUnattended, false);
  _resetCliKnobsCache();
});
