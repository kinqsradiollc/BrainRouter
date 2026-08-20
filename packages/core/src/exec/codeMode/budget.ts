/**
 * ADR-041 A41-15 (W3) — Code Mode dual budget + output cap.
 *
 * Enforcement is entirely parent-side and OS-level (group-SIGKILL), so a hostile
 * child cannot forge or evade it. The HARD ceilings are the wall clock and the
 * missed-heartbeat dead-man's-switch (a synchronous busy loop starves the child's
 * own heartbeat timer → no beat → kill); the compute meter is a best-effort
 * refinement layered on top. Output is hard-capped in chars.
 */

/** Why a run terminated (beyond a clean program return). */
export type CodeRunKillReason =
  | 'wall-clock'
  | 'starved'
  | 'compute'
  | 'output-overflow'
  | 'max-tool-calls'
  | 'aborted';

export interface CodeModeBudget {
  /** Hard wall-clock ceiling (ms) — catches idle-but-slow programs. */
  wallClockMs: number;
  /** No heartbeat for this long (ms) ⇒ the child is starving its own loop ⇒ kill. */
  heartbeatGraceMs: number;
  /** Best-effort self-reported event-loop-active budget (ms); a refinement, not the primary defense. */
  computeMs: number;
  /** Hard cap on the program's captured stdout/stderr (chars). */
  maxOutputChars: number;
  /** Hard cap on how many tools the program may call in one run. */
  maxToolCalls: number;
  /** Max concurrent in-flight tool calls (the parent's dispatch is serialized anyway). */
  maxInFlight: number;
}

/**
 * Defaults. Config maps `cli.codeMode.*` onto these; nothing here reads env vars
 * (BrainRouter rule — every CLI knob lives in `cli.*` of config.json).
 */
export const DEFAULT_CODE_MODE_BUDGET: CodeModeBudget = {
  wallClockMs: 30_000,
  heartbeatGraceMs: 2_000,
  computeMs: 20_000,
  maxOutputChars: 200_000,
  maxToolCalls: 200,
  maxInFlight: 8,
};

/** Merge partial overrides onto the defaults, clamping to sane positive bounds. */
export function resolveCodeModeBudget(overrides?: Partial<CodeModeBudget>): CodeModeBudget {
  const pick = (v: unknown, dflt: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : dflt;
  return {
    wallClockMs: pick(overrides?.wallClockMs, DEFAULT_CODE_MODE_BUDGET.wallClockMs, 100, 600_000),
    heartbeatGraceMs: pick(overrides?.heartbeatGraceMs, DEFAULT_CODE_MODE_BUDGET.heartbeatGraceMs, 200, 60_000),
    computeMs: pick(overrides?.computeMs, DEFAULT_CODE_MODE_BUDGET.computeMs, 100, 600_000),
    maxOutputChars: pick(overrides?.maxOutputChars, DEFAULT_CODE_MODE_BUDGET.maxOutputChars, 1_000, 5_000_000),
    maxToolCalls: pick(overrides?.maxToolCalls, DEFAULT_CODE_MODE_BUDGET.maxToolCalls, 1, 10_000),
    maxInFlight: pick(overrides?.maxInFlight, DEFAULT_CODE_MODE_BUDGET.maxInFlight, 1, 64),
  };
}
