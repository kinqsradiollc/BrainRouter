// ADR-041 A41-14 (W2) — the runtime-invariants registry + its verify gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerInvariantCompanion,
  invariantCompanions,
  verifyInvariants,
} from '../runtime/invariants.js';
import { registerBuiltinInvariantCompanions } from '../runtime/invariantCompanions.js';
import { runtimeCompositionSnapshot } from '../runtime/compositionSnapshot.js';

test('A41-14 — a companion with no invariants MUST state emptyReason', () => {
  assert.throws(
    () => registerInvariantCompanion({ area: 'test-empty-no-reason', invariants: [] }),
    /must state emptyReason/,
  );
  // An empty companion WITH a reason is accepted.
  registerInvariantCompanion({
    area: 'test-empty-with-reason',
    invariants: [],
    emptyReason: 'nothing runtime-checkable here',
  });
  assert.ok(invariantCompanions().some((c) => c.area === 'test-empty-with-reason'));
});

test('A41-14 — a duplicate area is refused (an area has one companion)', () => {
  registerInvariantCompanion({ area: 'test-dup', invariants: [], emptyReason: 'x' });
  assert.throws(() => registerInvariantCompanion({ area: 'test-dup', invariants: [], emptyReason: 'y' }), /Duplicate invariant companion/);
});

test('A41-14 — duplicate invariant names within an area are refused', () => {
  assert.throws(
    () =>
      registerInvariantCompanion({
        area: 'test-dupnames',
        invariants: [
          { name: 'same', check: () => null },
          { name: 'same', check: () => null },
        ],
      }),
    /Duplicate invariant name/,
  );
});

test('A41-14 — verifyInvariants collects violations; a holding check is silent', () => {
  registerInvariantCompanion({
    area: 'test-verify',
    invariants: [
      { name: 'holds', check: () => null },
      { name: 'breaks', check: () => 'this is broken' },
    ],
  });
  const all = verifyInvariants();
  assert.ok(all.some((v) => v.area === 'test-verify' && v.name === 'breaks' && v.message === 'this is broken'));
  assert.ok(!all.some((v) => v.area === 'test-verify' && v.name === 'holds'));
});

test('A41-14 — a check that throws is reported as a violation, not a crash', () => {
  registerInvariantCompanion({
    area: 'test-throws',
    invariants: [{ name: 'boom', check: () => { throw new Error('nope'); } }],
  });
  const scoped = verifyInvariants({ filter: /^test-throws\// });
  assert.equal(scoped.length, 1);
  assert.match(scoped[0].message, /check threw \(must be pure\): nope/);
});

test('A41-14 — regex filter activates only matching invariants', () => {
  // Only the test-throws area matches; nothing else leaks in.
  const scoped = verifyInvariants({ filter: /^test-throws\/boom$/ });
  assert.deepEqual(scoped.map((v) => `${v.area}/${v.name}`), ['test-throws/boom']);
});

test('A41-14 — the built-in companions are exhaustive and currently HOLD', () => {
  registerBuiltinInvariantCompanions();
  const areas = invariantCompanions().map((c) => c.area);
  // The baseline set the runtime ships with.
  assert.ok(areas.includes('tool-registry'), 'tool-registry companion registered');
  assert.ok(areas.includes('extension-events'), 'extension-events companion registered');
  assert.ok(areas.includes('tool-capabilities'), 'tool-capabilities companion registered (ADR-046)');
  assert.ok(areas.includes('session-history'), 'session-history companion registered (ADR-046)');
  // The real build must have zero violations across the built-in companions.
  const builtinViolations = verifyInvariants({ filter: /^(tool-registry|extension-events|tool-capabilities|session-history)\// });
  assert.deepEqual(builtinViolations, [], `built-in invariants must hold: ${JSON.stringify(builtinViolations)}`);
});

test('A41-14 — the composition snapshot surfaces the invariants (glass box)', () => {
  const snap = runtimeCompositionSnapshot();
  assert.ok(Array.isArray(snap.invariants.areas));
  assert.ok(snap.invariants.areas.some((a) => a.area === 'tool-registry'));
  const empty = snap.invariants.areas.find((a) => a.area === 'extension-events');
  assert.ok(empty && typeof empty.emptyReason === 'string' && empty.emptyReason.length > 0, 'empty companion carries its reason into the dump');
  // The count is a consistent projection of verifyInvariants(). (This process's
  // sibling tests register intentionally-breaking companions, so the absolute
  // count is not 0 here — the "built-in invariants hold" claim is the previous
  // test's job, run against the built-in areas in isolation via the regex filter.)
  assert.equal(snap.invariants.violations, verifyInvariants().length);
  assert.deepEqual(verifyInvariants({ filter: /^(tool-registry|extension-events|tool-capabilities|session-history)\// }), [], 'the built-in invariants hold in this build');
  // ADR-046 D2 — the tripwire channel is surfaced (advisory, separate from violations).
  assert.ok(Array.isArray(snap.invariants.runtimeReports), 'snapshot carries the tripwire totals');
});
