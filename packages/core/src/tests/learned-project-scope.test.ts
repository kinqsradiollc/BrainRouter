/**
 * A lesson knows where it was learned, and that changes what a turn is shown.
 *
 * The learned store partitions on `(orgId, userId)` and nothing else. Without a
 * project on the item, "run the migration before the seed" — true and useful in
 * the repository it came from — is delivered as a system message in every other
 * repository that person opens. It is then confident, specific and wrong, and D6
 * will never retire it there, because its falsifier is not observable in a
 * project that has no such migration.
 *
 * Scoping RANKS rather than filters, deliberately: the portable lessons are the
 * ones most worth keeping, and we have no reliable signal for which is which.
 * Asking the model to self-declare "this one generalises" is exactly the
 * plausible-but-unstable judgement ADR-033 says to keep out of its hands. So
 * same-project sorts first, foreign is capped, and unscoped is neither.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLearnedForTurn } from '../learning/context.js';
import type { LearnedItem } from '../learning/types.js';

const HERE = '/repo/alpha';
const ELSEWHERE = '/repo/beta';

function item(overrides: Partial<LearnedItem> & { id: string }): LearnedItem {
  return {
    tier: 'evidence',
    form: 'lesson',
    statement: `statement ${overrides.id}`,
    falsifier: 'something observable',
    status: 'active',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    outcome: { expectation: 'better', retrievals: 0, confirmations: 0, contradictions: 0 },
    provenance: {
      sessionKey: 's', capturedAt: '2026-08-10T00:00:00.000Z', checkpoint: 'turn-end',
      evidence: ['quoted'], corroboratedByTrustedAction: true, sawUntrustedContent: false,
      gateReasoning: 'admitted',
    },
    ...overrides,
  } as LearnedItem;
}

const withProject = (id: string, project: string, extra: Partial<LearnedItem> = {}) =>
  item({ id, ...extra, provenance: { ...item({ id }).provenance, project } } as never);

test('a lesson from this project outranks one from another', () => {
  const chosen = selectLearnedForTurn(
    [withProject('foreign', ELSEWHERE), withProject('local', HERE)],
    HERE,
  );
  assert.equal(chosen[0]!.id, 'local', 'the project being worked on comes first');
});

test('foreign lessons are capped so they cannot fill the window', () => {
  const many = Array.from({ length: 8 }, (_, i) => withProject(`foreign-${i}`, ELSEWHERE));
  const chosen = selectLearnedForTurn([...many, withProject('local', HERE)], HERE);
  const foreign = chosen.filter((entry) => entry.id.startsWith('foreign'));
  assert.ok(foreign.length <= 2, `foreign evidence must be capped, got ${foreign.length}`);
  assert.ok(chosen.some((entry) => entry.id === 'local'), 'the local lesson must survive the cap');
});

test('a human correction from elsewhere still outranks a local inference', () => {
  // Tier dominates scope on purpose: a person said the first one. Scope breaks
  // ties within a tier; it does not demote what a human corrected.
  const chosen = selectLearnedForTurn(
    [withProject('local-eval', HERE), withProject('foreign-instruction', ELSEWHERE, { tier: 'instruction' })],
    HERE,
  );
  assert.equal(chosen[0]!.id, 'foreign-instruction');
});

test('an item with no recorded project is neither preferred nor capped', () => {
  // Rows written before provenance carried a project have no answer. Guessing
  // one — treating it as local — would silently promote every legacy lesson.
  const chosen = selectLearnedForTurn(
    [item({ id: 'legacy' }), withProject('local', HERE)],
    HERE,
  );
  assert.equal(chosen[0]!.id, 'local', 'a known-local lesson beats an unscoped one');
  assert.ok(chosen.some((entry) => entry.id === 'legacy'), 'but the unscoped one is still offered');
});

test('with no current project, nothing is reordered and nothing is dropped', () => {
  // A host that does not know its workspace must not lose access to the store.
  const items = [withProject('a', HERE), withProject('b', ELSEWHERE), item({ id: 'c' })];
  const chosen = selectLearnedForTurn(items, undefined);
  assert.equal(chosen.length, 3);
});
