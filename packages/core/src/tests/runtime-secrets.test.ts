/**
 * MC-A5 — JIT secret indirection: the host SecretBroker (issue/redeem leases:
 * single-use, short-TTL, scope-checked), the env lease/resolve helpers, the
 * runtime-manager child-env chokepoint, and the sandbox exec-layer wiring.
 * Default-off invariant throughout: without `cli.runtime.jitSecrets` the
 * child env is byte-for-byte unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretBroker,
  SECRET_LEASE_ENV_PREFIX,
  getSecretBroker,
  _resetSecretBroker,
  hasSecretLeaseEnv,
  leaseSecretEnv,
  resolveLeaseEnv,
  prepareRuntimeChildEnv,
} from '../runtime/index.js';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { isSecretShapedEnvVar, resolveSandboxConfig } from '../exec/runtime/sandbox.js';

const nameLooksSecret = (name: string, value: string | undefined): boolean =>
  isSecretShapedEnvVar(name, value);

// ---------------------------------------------------------------------------
// Broker: issue / redeem lifecycle
// ---------------------------------------------------------------------------

test('MC-A5 broker: issue → redeem round-trips the provider value on demand', async () => {
  const broker = new SecretBroker();
  let resolved = 0;
  broker.registerSecret('GH_TOKEN', () => { resolved += 1; return 'ghp_' + 'a'.repeat(20); });

  const lease = broker.issue('GH_TOKEN', { ttlMs: 5_000, scope: 'session:s1' });
  assert.ok(lease.startsWith('brsl_'), 'lease is a token, not the value');
  assert.ok(!lease.includes('ghp_'), 'lease token never embeds the secret');
  assert.equal(resolved, 0, 'provider is NOT resolved at issue time');

  const value = await broker.redeem(lease, { scope: 'session:s1' });
  assert.equal(value, 'ghp_' + 'a'.repeat(20));
  assert.equal(resolved, 1, 'provider resolved exactly once, at redemption');
});

test('MC-A5 broker: redeeming the same lease twice fails (single-use)', async () => {
  const broker = new SecretBroker();
  broker.registerSecret('API_KEY', () => 'sk-value');
  const lease = broker.issue('API_KEY');
  assert.equal(await broker.redeem(lease), 'sk-value');
  await assert.rejects(() => broker.redeem(lease), /unknown, expired, or already redeemed/);
});

test('MC-A5 broker: an expired lease fails to redeem', async () => {
  let clock = 1_000_000;
  const broker = new SecretBroker({ now: () => clock });
  broker.registerSecret('API_KEY', () => 'sk-value');
  const lease = broker.issue('API_KEY', { ttlMs: 2_000 });
  clock += 2_001; // past the TTL
  await assert.rejects(() => broker.redeem(lease), /unknown, expired, or already redeemed/);
  assert.equal(broker.leaseCount(), 0, 'expired leases are pruned');
});

test('MC-A5 broker: scope mismatch fails without burning the lease', async () => {
  const broker = new SecretBroker();
  broker.registerSecret('DB_PASSWORD', () => 'hunter2-not-logged');
  const lease = broker.issue('DB_PASSWORD', { scope: 'exec:/ws/a' });
  await assert.rejects(() => broker.redeem(lease, { scope: 'exec:/ws/b' }), /scope mismatch/);
  await assert.rejects(() => broker.redeem(lease), /scope mismatch/); // missing scope ≠ right scope
  // The rightful scoped redeemer still gets exactly one redemption.
  assert.equal(await broker.redeem(lease, { scope: 'exec:/ws/a' }), 'hunter2-not-logged');
});

test('MC-A5 broker: issuing for an unregistered name fails; unknown token fails', async () => {
  const broker = new SecretBroker();
  assert.throws(() => broker.issue('NOPE'), /no secret provider registered/);
  await assert.rejects(() => broker.redeem('brsl_deadbeef'), /unknown, expired, or already redeemed/);
});

// ---------------------------------------------------------------------------
// Env helpers: lease ⇄ resolve
// ---------------------------------------------------------------------------

test('MC-A5 env: leaseSecretEnv indirects secret-shaped vars, passes the rest through', async () => {
  const broker = new SecretBroker();
  const env = { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-' + 'b'.repeat(12), LANG: 'en_US.UTF-8' };
  const leased = leaseSecretEnv(env, broker, { scope: 'session:x', isSecret: nameLooksSecret });

  assert.equal(leased.PATH, '/usr/bin');
  assert.equal(leased.LANG, 'en_US.UTF-8');
  assert.equal(leased.OPENAI_API_KEY, undefined, 'raw secret is gone');
  const leaseVar = leased[SECRET_LEASE_ENV_PREFIX + 'OPENAI_API_KEY'];
  assert.ok(typeof leaseVar === 'string' && leaseVar.startsWith('brsl_'), 'lease var carries a token');
  assert.ok(hasSecretLeaseEnv(leased));
  assert.ok(!hasSecretLeaseEnv(env));

  // Point-of-use: resolve turns the lease var back into the raw var.
  const resolved = await resolveLeaseEnv(leased, broker, { scope: 'session:x' });
  assert.equal(resolved.env.OPENAI_API_KEY, 'sk-' + 'b'.repeat(12));
  assert.equal(resolved.env[SECRET_LEASE_ENV_PREFIX + 'OPENAI_API_KEY'], undefined);
  assert.deepEqual(resolved.failed, []);

  // The lease was single-use: a second resolve drops the var and reports the NAME.
  const again = await resolveLeaseEnv(leased, broker, { scope: 'session:x' });
  assert.equal(again.env.OPENAI_API_KEY, undefined);
  assert.deepEqual(again.failed, ['OPENAI_API_KEY']);
});

// ---------------------------------------------------------------------------
// Runtime-manager chokepoint: prepareRuntimeChildEnv
// ---------------------------------------------------------------------------

test('MC-A5 default off: prepareRuntimeChildEnv leaves the raw env untouched', () => {
  const broker = new SecretBroker();
  const env = { MY_API_KEY: 'sk-' + 'c'.repeat(12), PLAIN: 'v' };
  const out = prepareRuntimeChildEnv(env, {
    jitSecrets: false, ttlMs: 60_000, scope: 'session:s', isSecret: nameLooksSecret, broker,
  });
  assert.equal(out, env, 'off → the exact same env object (no copies, no leases)');
  assert.equal(broker.leaseCount(), 0, 'no leases were minted');
});

test('MC-A5 on: prepareRuntimeChildEnv swaps secrets for lease vars redeemable by the exec layer', async () => {
  const broker = new SecretBroker();
  const env = { MY_API_KEY: 'sk-' + 'd'.repeat(12), PLAIN: 'v' };
  const out = prepareRuntimeChildEnv(env, {
    jitSecrets: true, ttlMs: 60_000, scope: 'session:s', isSecret: nameLooksSecret, broker,
  });
  assert.ok(out);
  assert.equal(out.MY_API_KEY, undefined, 'raw value not in the child env');
  assert.equal(out.PLAIN, 'v');
  const token = out[SECRET_LEASE_ENV_PREFIX + 'MY_API_KEY'];
  assert.ok(token?.startsWith('brsl_'));
  assert.equal(await broker.redeem(token, { scope: 'session:s' }), 'sk-' + 'd'.repeat(12));
});

// ---------------------------------------------------------------------------
// Config knobs
// ---------------------------------------------------------------------------

test('MC-A5 knobs: jitSecrets defaults false; TTL defaults 60s and clamps', () => {
  const defaults = resolveCliKnobs({ activeServer: '', servers: {} });
  assert.equal(defaults.runtime.jitSecrets, false);
  assert.equal(defaults.runtime.jitSecretTtlMs, 60_000);

  const custom = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { runtime: { jitSecrets: true, jitSecretTtlMs: 5 } },
  });
  assert.equal(custom.runtime.jitSecrets, true);
  assert.equal(custom.runtime.jitSecretTtlMs, 1_000, 'TTL clamps to ≥ 1s');

  const truthyButNotTrue = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { runtime: { jitSecrets: 'yes' as unknown as boolean } },
  });
  assert.equal(truthyButNotTrue.runtime.jitSecrets, false, 'only an explicit true opts in');
});

// ---------------------------------------------------------------------------
// Exec-layer wiring (resolveSandboxConfig → scopedEnv)
// ---------------------------------------------------------------------------

const WS = '/tmp/ws-runtime-secrets';
const RUNTIME_KNOBS_OFF = {
  backend: 'process' as const, maxLive: 0, archiveOnDispose: true, archiveMaxMB: 64,
  archiveKeep: 20, jitSecrets: false, jitSecretTtlMs: 60_000,
  // MC-A3 — container backend knobs (irrelevant here; pinned to defaults).
  containerImage: '', container: { cpus: 0, memory: '' },
};

test('MC-A5 sandbox default off: allowlisted secret stays RAW in scopedEnv (unchanged behavior)', () => {
  _resetCliKnobsCache();
  process.env.BR_MCA5_TEST_API_KEY = 'sk-' + 'e'.repeat(12);
  try {
    setCliKnobOverride({
      jobSecretScoping: true,
      jobSecretAllowlist: ['BR_MCA5_TEST_API_KEY'],
      sandboxEnforceWhenSilent: true,
      runtime: RUNTIME_KNOBS_OFF,
    });
    const cfg = resolveSandboxConfig(WS, {}, { silent: true, scopeSecrets: true });
    assert.ok(cfg.scopedEnv);
    assert.equal(cfg.scopedEnv!.BR_MCA5_TEST_API_KEY, 'sk-' + 'e'.repeat(12), 'raw pass-through as before');
    assert.equal(cfg.scopedEnv![SECRET_LEASE_ENV_PREFIX + 'BR_MCA5_TEST_API_KEY'], undefined);
    assert.equal(cfg.leaseScope, undefined);
  } finally {
    delete process.env.BR_MCA5_TEST_API_KEY;
    _resetCliKnobsCache();
    _resetSecretBroker();
  }
});

test('MC-A5 sandbox on: allowlisted secret travels as a lease the broker redeems under the exec scope', async () => {
  _resetCliKnobsCache();
  _resetSecretBroker();
  process.env.BR_MCA5_TEST_API_KEY = 'sk-' + 'f'.repeat(12);
  try {
    setCliKnobOverride({
      jobSecretScoping: true,
      jobSecretAllowlist: ['BR_MCA5_TEST_API_KEY'],
      sandboxEnforceWhenSilent: true,
      runtime: { ...RUNTIME_KNOBS_OFF, jitSecrets: true },
    });
    const cfg = resolveSandboxConfig(WS, {}, { silent: true, scopeSecrets: true });
    assert.ok(cfg.scopedEnv);
    assert.equal(cfg.scopedEnv!.BR_MCA5_TEST_API_KEY, undefined, 'no raw value in transit');
    const token = cfg.scopedEnv![SECRET_LEASE_ENV_PREFIX + 'BR_MCA5_TEST_API_KEY'];
    assert.ok(token?.startsWith('brsl_'), 'lease token in scopedEnv');
    assert.equal(cfg.leaseScope, `exec:${WS}`);
    // The exec layer's point-of-use redemption (what runShell does before spawn).
    const resolved = await resolveLeaseEnv(cfg.scopedEnv!, getSecretBroker(), { scope: cfg.leaseScope });
    assert.equal(resolved.env.BR_MCA5_TEST_API_KEY, 'sk-' + 'f'.repeat(12));
    assert.deepEqual(resolved.failed, []);
  } finally {
    delete process.env.BR_MCA5_TEST_API_KEY;
    _resetCliKnobsCache();
    _resetSecretBroker();
  }
});
