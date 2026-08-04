/**
 * ADR-028 A1 — capability is detected, not assumed.
 *
 * The property that matters: when the extension is missing the actions are
 * HIDDEN, and the reason names the specific missing piece. "Stacks are not
 * available" tells a human nothing; "gh is 2.71, stacks need 2.90" tells them
 * exactly what to run, and that is the difference between a feature that looks
 * broken and one that looks like it needs a command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  meetsMinimum,
  detectStackCapability,
  stackCapabilityFor,
  resetStackCapabilityCache,
  MIN_GH,
  type CapabilityProbe,
} from '../review/stackCapability.js';

function probe(over: Partial<CapabilityProbe> = {}): CapabilityProbe {
  return {
    ghVersion: async () => 'gh version 2.91.0 (2026-07-01)',
    gitVersion: async () => 'git version 2.39.5',
    hasStackExtension: async () => true,
    ...over,
  };
}

test('a fully-equipped machine is available', async () => {
  const cap = await detectStackCapability(probe());
  assert.equal(cap.available, true);
  assert.equal(cap.extensionInstalled, true);
  assert.equal(cap.reason, undefined);
});

test('a missing gh binary is reported as such, not as a generic failure', async () => {
  const cap = await detectStackCapability(probe({ ghVersion: async () => null }));
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /GitHub CLI \(`gh`\) is not installed/);
  assert.equal(cap.remediable, true);
});

test('too-old gh names the version found AND the version needed', async () => {
  // Without both numbers the human cannot tell whether they are close.
  const cap = await detectStackCapability(probe({
    ghVersion: async () => 'gh version 2.71.0 (2025-01-01)',
  }));
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /2\.71/);
  assert.match(cap.reason!, new RegExp(`${MIN_GH.major}\\.${MIN_GH.minor}`));
});

test('a missing extension names the exact install command', async () => {
  const cap = await detectStackCapability(probe({ hasStackExtension: async () => false }));
  assert.equal(cap.available, false);
  assert.equal(cap.extensionInstalled, false);
  assert.match(cap.reason!, /gh extension install github\/gh-stack/);
});

test('a probe that throws is unavailable, never an unhandled rejection', async () => {
  // A missing binary often surfaces as a spawn error rather than a null.
  const boom = async (): Promise<never> => { throw new Error('ENOENT'); };
  for (const key of ['ghVersion', 'gitVersion', 'hasStackExtension'] as const) {
    const cap = await detectStackCapability(probe({ [key]: boom } as Partial<CapabilityProbe>));
    assert.equal(cap.available, false, `${key} throwing must degrade, not propagate`);
    assert.ok(cap.reason);
  }
});

test('version comparison handles the major boundary', () => {
  // 3.0 satisfies a 2.90 minimum; 2.9 does not, and a naive numeric compare of
  // the minor gets that backwards.
  assert.equal(meetsMinimum({ major: 3, minor: 0 }, MIN_GH), true);
  assert.equal(meetsMinimum({ major: 2, minor: 90 }, MIN_GH), true);
  assert.equal(meetsMinimum({ major: 2, minor: 9 }, MIN_GH), false);
  assert.equal(meetsMinimum({ major: 1, minor: 99 }, MIN_GH), false);
  assert.equal(meetsMinimum(null, MIN_GH), false);
});

test('version parsing tolerates the shapes these tools actually print', () => {
  assert.deepEqual(parseVersion('gh version 2.91.0 (2026-07-01)'), { major: 2, minor: 91 });
  assert.deepEqual(parseVersion('git version 2.39.5 (Apple Git-154)'), { major: 2, minor: 39 });
  assert.deepEqual(parseVersion('2.90'), { major: 2, minor: 90 });
  assert.equal(parseVersion('no numbers here'), null);
  assert.equal(parseVersion(''), null);
});

test('detection is cached per workspace, and the cache is clearable', async () => {
  // It shells out three times; doing that per turn would tax every session for
  // an answer that changes when someone installs software.
  resetStackCapabilityCache();
  let calls = 0;
  const counting = probe({ ghVersion: async () => { calls += 1; return 'gh version 2.91.0'; } });

  await stackCapabilityFor('/w/a', counting);
  await stackCapabilityFor('/w/a', counting);
  assert.equal(calls, 1, 'second lookup for the same workspace must be cached');

  await stackCapabilityFor('/w/b', counting);
  assert.equal(calls, 2, 'a different workspace is probed separately');

  resetStackCapabilityCache('/w/a');
  await stackCapabilityFor('/w/a', counting);
  assert.equal(calls, 3, 'clearing lets an install be picked up');
  resetStackCapabilityCache();
});
