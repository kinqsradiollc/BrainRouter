/**
 * The vocabulary that makes fan-out "high effort" rather than "several copies of
 * the same question".
 *
 * Three children asking the same thing in three folders is breadth of PATH, not
 * breadth of THINKING — it costs three times as much and returns one angle. The
 * lens lists below are the concrete distinctions the runtime asks children to
 * split on, exported as data (not prose in a prompt) so the router, the tool
 * descriptions, the workflow templates and the turn guards all name the same
 * contract instead of each inventing their own adjectives.
 *
 * Everything here is a hoisted FUNCTION, deliberately, not an exported `const`.
 * `orchestration/tools.ts` and `extension/builtin/toolSpecs.ts` form an import
 * cycle, and `toolSpecs` calls the tool-spec factories at module scope — so a
 * factory can run before its own module body has been evaluated. Function
 * declarations are initialized at instantiation and survive that; a `const`
 * read from the same call site throws "cannot access before initialization".
 */

/** Review angles. Disjoint on purpose: a finding belongs to exactly one. */
export function reviewLenses(): readonly string[] {
  return [
    'correctness & logic',
    'security & input handling',
    'regressions & missed requirements',
  ];
}

/** Investigation angles for an open question about existing behavior. */
export function investigationLenses(): readonly string[] {
  return [
    'current behavior & control flow',
    'constraints, invariants & failure modes',
    'callers, dependents & blast radius',
  ];
}

/**
 * The brief that makes a fan-out adversarial. Its output is answered, not
 * merged: a synthesis nobody tried to break is an opinion, and the whole point
 * of spending N children is to buy a conclusion that survived an attack.
 */
export function adversarialLens(): string {
  return 'falsify the synthesis — argue it is wrong, cite the evidence that contradicts it, and name what was never checked';
}

/**
 * True when a set of spawned children carry fewer than two distinct lenses —
 * i.e. the model fanned out in name only. Labels are lower-cased and trimmed
 * before comparison; blank labels count as one shared "unlabelled" lens, because
 * an unlabelled batch is exactly the undifferentiated case this catches.
 */
export function isUndifferentiatedFanOut(labels: readonly (string | undefined)[]): boolean {
  if (labels.length < 2) return false;
  const distinct = new Set(labels.map((label) => (label ?? '').trim().toLowerCase()));
  return distinct.size < 2;
}
