/**
 * ADR-041 D13 (A41-14, W2) — the runtime-invariants registry.
 *
 * BrainRouter already guards a dozen "this must stay true" facts, but each lives
 * as its own ad-hoc assertion (`assertLocalToolExecutorInvariants`) or golden
 * inventory test, discovered only by whoever wrote it. This generalizes that into
 * a first-class, package-owned system: each AREA of the workspace registers an
 * **invariant companion** — a named bundle of runtime invariants it guarantees —
 * and a mechanical verify gate runs them with regex-filtered activation.
 *
 * Two rules make it exhaustive rather than decorative:
 *   - An area registers exactly one companion (a duplicate area is a bug).
 *   - A companion with NO invariants must state `emptyReason` — "this area has
 *     none" becomes an explicit, reviewed claim, never a silent omission.
 *
 * The checks are PURE (no side effects, no throws): each returns `null` when the
 * invariant holds, or a human-readable violation string when it does not. The
 * verify gate collects violations instead of throwing on the first, so one run
 * reports every break. `runtimeCompositionSnapshot()` surfaces the registered
 * companions in the composition dump (the glass box shows what the runtime
 * guarantees), and the verify-gate test asserts zero violations + exhaustive
 * coverage.
 */

/** One runtime invariant: a pure predicate that names how it can be violated. */
export interface InvariantCheck {
  /** Stable, unique-within-its-companion name (e.g. `executor-tier-matches-registry`). */
  name: string;
  /**
   * The check. Returns `null`/`undefined` when the invariant holds, or a
   * human-readable message describing the violation. MUST be pure — no throwing,
   * no mutation, no I/O — so the verify gate can run every check and collect all
   * breaks in one pass.
   */
  check(): string | null | undefined;
}

/** The set of invariants one workspace area guarantees at runtime. */
export interface InvariantCompanion {
  /** The area this companion covers (e.g. `tool-registry`). Unique across the registry. */
  area: string;
  /** The invariants this area guarantees. May be empty ONLY with an `emptyReason`. */
  invariants: InvariantCheck[];
  /**
   * Required WHEN `invariants` is empty: why this area has no runtime invariants
   * (e.g. "covered by the golden inventory test; nothing runtime-checkable"). Makes
   * an empty companion a reviewed claim, not an oversight.
   */
  emptyReason?: string;
}

/** A single invariant break, from {@link verifyInvariants}. */
export interface InvariantViolation {
  area: string;
  name: string;
  message: string;
}

const COMPANIONS = new Map<string, InvariantCompanion>();

/**
 * Register an area's invariant companion. Throws on a duplicate area (an area has
 * one companion) or on an empty companion with no `emptyReason` (an unexplained
 * empty companion is the oversight this system exists to prevent).
 */
export function registerInvariantCompanion(companion: InvariantCompanion): void {
  if (COMPANIONS.has(companion.area)) {
    throw new Error(`Duplicate invariant companion for area: ${companion.area}`);
  }
  if (companion.invariants.length === 0 && !companion.emptyReason?.trim()) {
    throw new Error(
      `Invariant companion for area "${companion.area}" is empty and must state emptyReason (why it has no runtime invariants).`,
    );
  }
  const names = new Set<string>();
  for (const inv of companion.invariants) {
    if (names.has(inv.name)) {
      throw new Error(`Duplicate invariant name "${inv.name}" in area "${companion.area}".`);
    }
    names.add(inv.name);
  }
  COMPANIONS.set(companion.area, companion);
}

/** Every registered companion, in registration order. */
export function invariantCompanions(): readonly InvariantCompanion[] {
  return [...COMPANIONS.values()];
}

/**
 * Run the registered invariants and return every violation (empty = all hold).
 *
 * `filter` activates only invariants whose `${area}/${name}` identifier matches —
 * the regex-filtered activation the ADR calls for, so a caller can verify one
 * subsystem in isolation. A check that itself throws is reported as a violation
 * (a check must be pure; a throwing check is a broken invariant, not a crash).
 */
export function verifyInvariants(opts?: { filter?: RegExp }): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const companion of COMPANIONS.values()) {
    for (const inv of companion.invariants) {
      const id = `${companion.area}/${inv.name}`;
      if (opts?.filter && !opts.filter.test(id)) continue;
      let message: string | null | undefined;
      try {
        message = inv.check();
      } catch (err) {
        message = `check threw (must be pure): ${err instanceof Error ? err.message : String(err)}`;
      }
      if (message) violations.push({ area: companion.area, name: inv.name, message });
    }
  }
  return violations;
}
