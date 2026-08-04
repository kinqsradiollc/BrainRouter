/**
 * ADR-028 C1 — wire the setting, or delete it.
 *
 * `cli.executionEngine` has been resolved, validated and unit-tested since
 * 0.4.19, and until now **nothing read it**. The graph executor it selects also
 * had no non-test caller. Two finished modules pointing at each other, with no
 * path between them — the fifth instance of the pattern this ADR exists to
 * remove, and the most visible, because this one has a switch in the settings
 * UI that a person can flip and watch do nothing.
 *
 * The ADR rejected deleting the knob: the graph's value for interrupted,
 * resumable work is real. But it is currently zero, and left alone it would
 * stay zero.
 *
 * Two things live here:
 *
 *  - **The seam.** One place that turns the resolved knob into the engine that
 *    actually runs, so `runTurn` dispatches on it rather than ignoring it.
 *  - **The capability declaration.** What each engine genuinely supports, as
 *    data, so the parity matrix can FAIL when they diverge instead of parity
 *    being assumed. Without that, "both ship" decays into "one ships and one
 *    exists" — which is precisely what happened here.
 */

export type EngineKind = 'loop' | 'graph';

/**
 * The features a turn engine has to provide.
 *
 * Selectable has to mean equivalent. An engine you can choose that quietly
 * drops interrupts or tool authorization is not an alternative, it is a
 * downgrade wearing a setting.
 */
export interface EngineCapabilities {
  /** A running turn can be interrupted and steered. */
  interrupts: boolean;
  /** Tool calls go through the same authorization path. */
  toolAuthorization: boolean;
  /** Steer/queue receipts are produced (ADR-028 B1). */
  receipts: boolean;
  /** Execution can stop and resume without repeating side effects. */
  resumable: boolean;
  /** Sub-agent delegation is available. */
  delegation: boolean;
}

/** Every capability a caller may rely on. Adding one here breaks parity loudly. */
export const REQUIRED_CAPABILITIES: readonly (keyof EngineCapabilities)[] = [
  'interrupts',
  'toolAuthorization',
  'receipts',
  'resumable',
  'delegation',
];

/**
 * What each engine actually supports today.
 *
 * Honest rather than aspirational. The graph executor checkpoints at node
 * boundaries and enforces idempotency keys on side-effecting nodes, so
 * `resumable` is genuinely true and is the reason the engine is worth keeping.
 * The rest is not wired yet, and saying so here is what makes the gap
 * actionable instead of invisible.
 */
export const ENGINE_CAPABILITIES: Record<EngineKind, EngineCapabilities> = {
  loop: {
    interrupts: true,
    toolAuthorization: true,
    receipts: true,
    resumable: false,
    delegation: true,
  },
  graph: {
    interrupts: false,
    toolAuthorization: false,
    receipts: false,
    resumable: true,
    delegation: false,
  },
};

/** Capabilities the loop has and this engine does not. */
export function capabilityGap(engine: EngineKind): (keyof EngineCapabilities)[] {
  const theirs = ENGINE_CAPABILITIES[engine];
  const loop = ENGINE_CAPABILITIES.loop;
  return REQUIRED_CAPABILITIES.filter((c) => loop[c] && !theirs[c]);
}

/** Is this engine a safe default for ordinary work? */
export function isEngineReady(engine: EngineKind): boolean {
  return capabilityGap(engine).length === 0;
}

export interface EngineSelection {
  /** The engine that will actually run. */
  engine: EngineKind;
  /** What the user asked for, which may differ. */
  requested: EngineKind;
  /** Set when the request was not honoured, in words that say why. */
  notice?: string;
  /** Capabilities missing from the REQUESTED engine, honoured or not. */
  gap: (keyof EngineCapabilities)[];
}

/**
 * Resolve the knob into the engine that runs.
 *
 * A request for an engine missing features the loop has is not silently
 * honoured and not silently ignored — it falls back, and it SAYS SO. Silently
 * honouring it would mean a person flips a setting and loses interrupts without
 * being told; silently ignoring it is the bug this decision exists to fix.
 *
 * `allowIncomplete` exists for the people developing the graph path, who need
 * to run it precisely because it is incomplete.
 */
export function selectEngine(
  requested: EngineKind,
  opts: { allowIncomplete?: boolean } = {},
): EngineSelection {
  const gap = capabilityGap(requested);
  if (gap.length === 0) {
    return { engine: requested, requested, gap };
  }
  if (opts.allowIncomplete) {
    return {
      engine: requested,
      requested,
      gap,
      notice:
        `Running the ${requested} engine with known gaps: ${gap.join(', ')}. ` +
        'This is a development mode; ordinary work should use the loop.',
    };
  }
  return {
    engine: 'loop',
    requested,
    gap,
    notice:
      `The ${requested} engine is selected but does not yet support ${gap.join(', ')}, so this turn ` +
      'ran on the loop. Choosing it would have removed features without telling you.',
  };
}

/**
 * The line shown in the session while work happens.
 *
 * A setting whose effect is invisible is one nobody trusts they changed, so the
 * running engine is named where the work is, not only where the switch is.
 */
export function describeRunningEngine(selection: EngineSelection): string {
  if (selection.engine === selection.requested) {
    return `Engine: ${selection.engine}`;
  }
  return `Engine: ${selection.engine} (${selection.requested} requested)`;
}
