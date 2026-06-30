import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { resolveSandboxConfig, scopeSecretEnv } from '../exec/sandbox.js';

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

// --- HONK-H0: forced enforcement (fleet) + secret-env scoping ---------------

test('HONK-H0: forceEnforce overrides an operator opt-out (sandboxEnforceWhenSilent:false)', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'off', sandboxNetwork: true, sandboxUnavailable: 'warn', sandboxEnforceWhenSilent: false });
  // A normal silent child honors the opt-out (unsandboxed)…
  assert.equal(resolveSandboxConfig(WS, {}, { silent: true }).enabled, false);
  // …but a fleet child (forceEnforce) is sandboxed + network-denied + fail-closed anyway.
  const cfg = resolveSandboxConfig(WS, {}, { silent: true, forceEnforce: true });
  assert.equal(cfg.enabled, true, 'fleet sandbox cannot be opted out');
  assert.equal(cfg.allowNetwork, false);
  assert.equal(cfg.unavailableMode, 'deny');
  assert.equal(cfg.enforcedUnattended, true);
  _resetCliKnobsCache();
});

test('HONK-H0: scopeSecrets scrubs secret env on an enforced run; off when not requested', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'off', sandboxEnforceWhenSilent: true, jobSecretScoping: true });
  process.env.BR_TEST_OPENAI_API_KEY = 'sk-shouldnotleak123';
  try {
    // Fleet/enforced run with scoping → scopedEnv excludes the secret.
    const scoped = resolveSandboxConfig(WS, {}, { silent: true, forceEnforce: true, scopeSecrets: true });
    assert.ok(scoped.scopedEnv, 'scopedEnv is set for a scoped enforced run');
    assert.equal(scoped.scopedEnv!.BR_TEST_OPENAI_API_KEY, undefined, 'secret env scrubbed');
    assert.equal(scoped.scopedEnv!.PATH, process.env.PATH, 'non-secret env preserved');
    // A non-scoping silent run inherits the full env (scopedEnv undefined).
    const unscoped = resolveSandboxConfig(WS, {}, { silent: true });
    assert.equal(unscoped.scopedEnv, undefined);
  } finally {
    delete process.env.BR_TEST_OPENAI_API_KEY;
    _resetCliKnobsCache();
  }
});

test('HONK-H0: jobSecretScoping=false is a global kill switch for scoping', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandboxEnforceWhenSilent: true, jobSecretScoping: false });
  const cfg = resolveSandboxConfig(WS, {}, { silent: true, forceEnforce: true, scopeSecrets: true });
  assert.equal(cfg.scopedEnv, undefined, 'no scoping when the kill switch is off');
  _resetCliKnobsCache();
});

test('HONK-H0: scopeSecretEnv masks secret-shaped vars, keeps the rest, honors allowlist', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'sk-abc', DATABASE_PASSWORD: 'hunter2', GITHUB_TOKEN: 'ghp_x',
    MY_SESSION: 'z', NORMAL_VAR: 'keepme', WEIRD: 'sk-abcdef123456',
  };
  const out = scopeSecretEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.NORMAL_VAR, 'keepme');
  for (const dropped of ['OPENAI_API_KEY', 'DATABASE_PASSWORD', 'GITHUB_TOKEN', 'MY_SESSION', 'WEIRD']) {
    assert.equal(out[dropped], undefined, `${dropped} scrubbed (by name or value shape)`);
  }
  // Allowlist re-grants a specific var a job legitimately needs.
  assert.equal(scopeSecretEnv(env, { allow: ['OPENAI_API_KEY'] }).OPENAI_API_KEY, 'sk-abc');
});
