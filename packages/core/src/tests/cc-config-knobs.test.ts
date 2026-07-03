/**
 * CC-CONFIG (A-config) — Config/CLI knob parity features:
 *   A1 safeMode, A2 fallbackModels chain, A3 availableModels enforcement,
 *   A4 version range, A5 attribution.sessionUrl footer, A6 skillsHideBundled.
 *
 * Pure over `resolveCliKnobs` + the model-policy helpers — no live provider,
 * no config file, no env-write side effects (env-driven knobs are restored).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliKnobs, setCliKnobOverride, _resetCliKnobsCache } from '../config/config.js';
import { assertModelAllowed, isModelAllowed, checkVersionRange, compareSemver } from '../provider/modelPolicy.js';
import { derivePrBody } from '../git/prEmit.js';
import { makeAgent, withTempWorkspace } from './_helpers.js';

const cfg = (cli: Record<string, unknown>) => ({ activeServer: '', servers: {}, cli } as any);

// ---------------------------------------------------------------------------
// A2 — fallbackModels ordering + legacy back-compat
// ---------------------------------------------------------------------------

test('A2 resolveFallbackModels: preserves order, dedupes, caps at 3', () => {
  const k = resolveCliKnobs(cfg({ fallbackModels: ['a', 'b', 'a', 'c', 'd'] }));
  assert.deepEqual(k.fallbackModels, ['a', 'b', 'c']); // dup 'a' dropped, capped to 3
});

test('A2 resolveFallbackModels: legacy single fallbackModel appended last (back-compat)', () => {
  const only = resolveCliKnobs(cfg({ fallbackModel: 'legacy' }));
  assert.deepEqual(only.fallbackModels, ['legacy']);
  const both = resolveCliKnobs(cfg({ fallbackModels: ['a', 'b'], fallbackModel: 'legacy' }));
  assert.deepEqual(both.fallbackModels, ['a', 'b', 'legacy']);
  // Legacy already in the chain → not duplicated.
  const dup = resolveCliKnobs(cfg({ fallbackModels: ['a', 'legacy'], fallbackModel: 'legacy' }));
  assert.deepEqual(dup.fallbackModels, ['a', 'legacy']);
});

test('A2 resolveFallbackModels: trims blanks + tolerates non-arrays', () => {
  assert.deepEqual(resolveCliKnobs(cfg({ fallbackModels: ['  x ', '', 'y'] })).fallbackModels, ['x', 'y']);
  assert.deepEqual(resolveCliKnobs(cfg({ fallbackModels: 'not-an-array' })).fallbackModels, []);
  assert.deepEqual(resolveCliKnobs(cfg({})).fallbackModels, []); // absent
});

// ---------------------------------------------------------------------------
// A3 — availableModels enforcement
// ---------------------------------------------------------------------------

test('A3 resolveCliKnobs: availableModels sanitized + enforce flag', () => {
  const k = resolveCliKnobs(cfg({ availableModels: ['gpt-x', ' gpt-x ', 'gpt-y', 3], enforceAvailableModels: true }));
  assert.deepEqual(k.availableModels, ['gpt-x', 'gpt-y']); // dedupe/trim, drop non-strings
  assert.equal(k.enforceAvailableModels, true);
  assert.equal(resolveCliKnobs(cfg({})).enforceAvailableModels, false); // default off
});

test('A3 isModelAllowed / assertModelAllowed: empty list = no restriction', () => {
  assert.equal(isModelAllowed('anything', []), true);
  assert.equal(isModelAllowed('anything', undefined), true);
  assert.equal(assertModelAllowed('anything', [], true), null); // enforce but empty → allowed
});

test('A3 assertModelAllowed: rejects unlisted only when enforced + list non-empty', () => {
  const list = ['gpt-x', 'gpt-y'];
  assert.equal(assertModelAllowed('gpt-x', list, true), null); // listed → allowed
  assert.equal(assertModelAllowed('gpt-z', list, false), null); // not enforced → allowed
  const err = assertModelAllowed('gpt-z', list, true, 'Fast mode');
  assert.ok(err && err.includes('Fast mode') && err.includes('gpt-z')); // clear message names context + model
});

// ---------------------------------------------------------------------------
// A4 — version range
// ---------------------------------------------------------------------------

test('A4 compareSemver + checkVersionRange bounds', () => {
  assert.equal(compareSemver('0.4.17', '0.4.16'), 1);
  assert.equal(compareSemver('0.4.16', '0.4.16'), 0);
  assert.equal(compareSemver('0.4.15', '0.4.16'), -1);

  assert.equal(checkVersionRange('0.4.17', '0.4.16', '0.5.0').ok, true); // inside
  assert.equal(checkVersionRange('0.4.10', '0.4.16', '').ok, false); // below min
  assert.equal(checkVersionRange('0.6.0', '', '0.5.0').ok, false); // above max
  assert.equal(checkVersionRange('0.4.17', '', '').ok, true); // open bounds
});

test('A4 resolveCliKnobs: version-range knobs default to unset + off', () => {
  const d = resolveCliKnobs(cfg({}));
  assert.equal(d.requiredMinimumVersion, '');
  assert.equal(d.requiredMaximumVersion, '');
  assert.equal(d.enforceVersionRange, false);
  const set = resolveCliKnobs(cfg({ requiredMinimumVersion: ' 0.4.16 ', enforceVersionRange: true }));
  assert.equal(set.requiredMinimumVersion, '0.4.16'); // trimmed
  assert.equal(set.enforceVersionRange, true);
});

// ---------------------------------------------------------------------------
// A1 — safeMode (config + env)
// ---------------------------------------------------------------------------

test('A1 resolveCliKnobs: safeMode default off, config true honored', () => {
  assert.equal(resolveCliKnobs(cfg({})).safeMode, false);
  assert.equal(resolveCliKnobs(cfg({ safeMode: true })).safeMode, true);
});

test('A1 safeMode: BRAINROUTER_SAFE_MODE env wins over config', () => {
  const prev = process.env.BRAINROUTER_SAFE_MODE;
  try {
    process.env.BRAINROUTER_SAFE_MODE = '1';
    assert.equal(resolveCliKnobs(cfg({ safeMode: false })).safeMode, true); // env forces on
    process.env.BRAINROUTER_SAFE_MODE = 'off';
    assert.equal(resolveCliKnobs(cfg({ safeMode: true })).safeMode, false); // env forces off
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_SAFE_MODE;
    else process.env.BRAINROUTER_SAFE_MODE = prev;
  }
});

// ---------------------------------------------------------------------------
// A5 — attribution.sessionUrl footer
// ---------------------------------------------------------------------------

test('A5 resolveCliKnobs: attribution.sessionUrl defaults true, false honored', () => {
  assert.equal(resolveCliKnobs(cfg({})).attribution.sessionUrl, true);
  assert.equal(resolveCliKnobs(cfg({ attribution: { sessionUrl: false } })).attribution.sessionUrl, false);
});

test('A5 derivePrBody: footer omitted when attributionSessionUrl=false', () => {
  const withFooter = derivePrBody({ slug: 's', verifyGreen: true, changedFiles: 1, attributionSessionUrl: true });
  const noFooter = derivePrBody({ slug: 's', verifyGreen: true, changedFiles: 1, attributionSessionUrl: false });
  assert.match(withFooter, /Generated by BrainRouter/);
  assert.doesNotMatch(noFooter, /Generated by BrainRouter/);
  // No Claude-branded attribution ever (BrainRouter's own-product rule).
  assert.doesNotMatch(withFooter, /Claude/);
});

// ---------------------------------------------------------------------------
// A6 — skillsHideBundled (config + env)
// ---------------------------------------------------------------------------

test('A6 resolveCliKnobs: skillsHideBundled default off, env override wins', () => {
  assert.equal(resolveCliKnobs(cfg({})).skillsHideBundled, false);
  assert.equal(resolveCliKnobs(cfg({ skillsHideBundled: true })).skillsHideBundled, true);
  const prev = process.env.BRAINROUTER_HIDE_BUNDLED_SKILLS;
  try {
    process.env.BRAINROUTER_HIDE_BUNDLED_SKILLS = 'true';
    assert.equal(resolveCliKnobs(cfg({ skillsHideBundled: false })).skillsHideBundled, true);
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_HIDE_BUNDLED_SKILLS;
    else process.env.BRAINROUTER_HIDE_BUNDLED_SKILLS = prev;
  }
});

test('E2 resolveCliKnobs: markdownCheckboxes defaults true, false honored', () => {
  assert.equal(resolveCliKnobs(cfg({})).markdownCheckboxes, true);
  assert.equal(resolveCliKnobs(cfg({ markdownCheckboxes: true })).markdownCheckboxes, true);
  assert.equal(resolveCliKnobs(cfg({ markdownCheckboxes: false })).markdownCheckboxes, false);
});

// ---------------------------------------------------------------------------
// A1 — safe mode disables lifecycle hooks (the hook-gate wiring)
// ---------------------------------------------------------------------------

test('A1 safe mode: hookEnforceActive / hookAdvisoryActive are false when safeMode is on', () => {
  withTempWorkspace((ws) => {
    const agent = makeAgent(ws) as any;
    agent.silent = false; // interactive session so the gates are otherwise live
    try {
      // Baseline: hooks active (default knobs, safe mode explicitly off).
      _resetCliKnobsCache(); // clear first — reset wipes overrides
      setCliKnobOverride({ safeMode: false });
      assert.equal(agent.hookEnforceActive(), true, 'hooks enforce when not in safe mode');
      assert.equal(agent.hookAdvisoryActive(), true, 'advisory hooks run when not in safe mode');
      // Safe mode disables both gates.
      setCliKnobOverride({ safeMode: true });
      assert.equal(agent.hookEnforceActive(), false, 'safe mode disables enforcing hooks');
      assert.equal(agent.hookAdvisoryActive(), false, 'safe mode disables advisory hooks');
    } finally {
      _resetCliKnobsCache();
    }
  });
});
