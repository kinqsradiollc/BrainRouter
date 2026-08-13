/**
 * ADR-028 A1 — capability is detected, not assumed.
 *
 * The property that matters: when a piece is missing the create path opens an
 * ordinary pull request, and the reason names the specific missing piece.
 * "Stacks are not available" tells a human nothing; "gh is 2.71, stacks need
 * 2.90" tells them exactly what to run, and that is the difference between a
 * feature that looks broken and one that looks like it needs a command.
 *
 * There is ONE detector — `probeStackCapability` — and these tests drive it
 * through its injected runner. The cached async detector that used to sit
 * beside it was retired: it had no caller outside this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, meetsMinimum, MIN_GH, MIN_GIT } from '../review/stackCapability.js';
import { probeStackCapability, type ProbeRunner } from '../review/stackProbe.js';

/** A machine with everything, overridable one command at a time. */
function runner(over: Record<string, string | null> = {}): ProbeRunner {
  const answers: Record<string, string | null> = {
    'gh --version': 'gh version 2.91.0 (2026-07-01)\nhttps://github.com/cli/cli/releases',
    'git --version': 'git version 2.39.5 (Apple Git-154)',
    'gh extension list': 'gh stack\tgithub/gh-stack\tv0.3.0',
    ...over,
  };
  return (cmd, args) => answers[[cmd, ...args].join(' ')] ?? null;
}

test('a fully-equipped machine is available', () => {
  const cap = probeStackCapability('/w', runner());
  assert.equal(cap.available, true);
  assert.equal(cap.extensionInstalled, true);
  assert.equal(cap.reason, undefined);
  // The release-notes URL `gh --version` prints underneath must not end up in
  // the reported version.
  assert.equal(cap.ghVersion, 'gh version 2.91.0 (2026-07-01)');
});

test('a missing gh binary is reported as such, not as a generic failure', () => {
  const cap = probeStackCapability('/w', runner({ 'gh --version': null }));
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /GitHub CLI \(`gh`\) is not installed/);
  assert.equal(cap.remediable, true);
});

test('too-old gh names the version found AND the version needed', () => {
  // Without both numbers the human cannot tell whether they are close.
  const cap = probeStackCapability('/w', runner({ 'gh --version': 'gh version 2.71.0 (2025-01-01)' }));
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /2\.71/);
  assert.match(cap.reason!, new RegExp(`${MIN_GH.major}\\.${MIN_GH.minor}`));
});

test('too-old git is unavailable, even with a new gh and the extension present', () => {
  // A1 requires git 2.20+ as well as gh 2.90+. `gh stack` drives git's own
  // rebase machinery, so an old git fails PARTWAY THROUGH a restack rather than
  // up front — which is the failure that leaves a half-rebased tree behind.
  const cap = probeStackCapability('/w', runner({ 'git --version': 'git version 2.17.1' }));
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /2\.17/);
  assert.match(cap.reason!, new RegExp(`git ${MIN_GIT.major}\\.${MIN_GIT.minor}`));
  assert.equal(cap.remediable, true);
});

test('a git that cannot run at all says it was not found', () => {
  const cap = probeStackCapability('/w', runner({ 'git --version': null }));
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /was not found/);
});

test('a missing extension names the exact install command', () => {
  const cap = probeStackCapability('/w', runner({ 'gh extension list': 'gh poi\towner/gh-poi\tv1' }));
  assert.equal(cap.available, false);
  assert.equal(cap.extensionInstalled, false);
  assert.match(cap.reason!, /gh extension install github\/gh-stack/);
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
