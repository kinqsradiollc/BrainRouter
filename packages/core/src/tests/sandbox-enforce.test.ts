import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { resolveSandboxConfig, scopeSecretEnv, windowsPathToWsl, windowsWslSandboxPlan } from '../exec/runtime/sandbox.js';

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

test('Windows sandbox maps drive paths into a WSL bubblewrap argv without a shell boundary', () => {
  assert.equal(windowsPathToWsl('C:\\work\\BrainRouter'), '/mnt/c/work/BrainRouter');
  assert.equal(windowsPathToWsl('D:/tmp/repo'), '/mnt/d/tmp/repo');
  assert.equal(windowsPathToWsl('\\\\server\\share\\repo'), undefined);
  assert.equal(windowsPathToWsl('C:\\work\\..\\escape'), undefined);
  const plan = windowsWslSandboxPlan({
    enabled: true,
    workspaceRoot: 'C:\\work\\BrainRouter',
    readPaths: ['D:\\sdk'],
    writePaths: ['C:\\temp\\out'],
    allowNetwork: false,
    unavailableMode: 'deny',
  }, 'npm test && echo $HOME');
  assert.equal(plan?.executable, 'wsl.exe');
  assert.deepEqual(plan?.args.slice(0, 2), ['--exec', 'bwrap']);
  assert.ok(plan?.args.includes('/mnt/c/work/BrainRouter'));
  assert.ok(plan?.args.includes('/mnt/d/sdk'));
  assert.ok(plan?.args.includes('/mnt/c/temp/out'));
  assert.ok(plan?.args.includes('--unshare-net'));
  assert.deepEqual(plan?.args.slice(-3), ['/bin/sh', '-c', 'npm test && echo $HOME']);
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

test('HONK-H0: scopeSecretEnv masks secret-shaped vars (incl. real-world shapes), keeps the rest', () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', SHELL: '/bin/sh', NORMAL_VAR: 'keepme',
    OPENAI_API_KEY: 'sk-abc', DATABASE_PASSWORD: 'hunter2', GITHUB_TOKEN: 'ghp_x', MY_SESSION: 'z',
    // shapes the first cut missed (PGPASSWORD has no underscore; PWD; cred-bearing URLs; AWS id; DSN; JWT)
    PGPASSWORD: 'hunter2', MYSQL_PWD: 'hunter2', SECRET_KEY_BASE: 'x', AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    DATABASE_URL: 'postgres://app:s3cr3t@db.internal/prod', SENTRY_DSN: 'https://k@o.ingest.sentry.io/1',
    JWT_BLOB: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', WEIRD: 'sk-abcdef123456',
  };
  const out = scopeSecretEnv(env);
  for (const keep of ['PATH', 'HOME', 'LANG', 'SHELL', 'NORMAL_VAR']) assert.ok(out[keep], `${keep} preserved`);
  for (const dropped of ['OPENAI_API_KEY', 'DATABASE_PASSWORD', 'GITHUB_TOKEN', 'MY_SESSION', 'PGPASSWORD',
    'MYSQL_PWD', 'SECRET_KEY_BASE', 'AWS_ACCESS_KEY_ID', 'DATABASE_URL', 'SENTRY_DSN', 'JWT_BLOB', 'WEIRD']) {
    assert.equal(out[dropped], undefined, `${dropped} scrubbed (by name or value shape)`);
  }
  // Allowlist re-grants a var a job needs — and is CASE-INSENSITIVE.
  assert.equal(scopeSecretEnv(env, { allow: ['openai_api_key'] }).OPENAI_API_KEY, 'sk-abc', 'allowlist is case-insensitive');
});

test('HONK-H0: forceEnforce locks down even a NON-silent caller (decoupled from silent)', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ sandbox: 'off', sandboxNetwork: true, sandboxEnforceWhenSilent: false });
  const cfg = resolveSandboxConfig(WS, {}, { silent: false, forceEnforce: true });
  assert.equal(cfg.enabled, true, 'forceEnforce forces sandbox regardless of silent');
  assert.equal(cfg.allowNetwork, false);
  assert.equal(cfg.enforcedUnattended, true);
  _resetCliKnobsCache();
});
