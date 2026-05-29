/**
 * 0.3.7 wizard — pure types + step state machine.
 *
 * The wizard walks the user through a small, ordered sequence of
 * decisions. Each step has its own decision shape; together they fill
 * in a `WizardDraft` that the Done step commits to disk.
 *
 * Why a typed Step enum + draft (instead of one giant async function
 * with awaits in sequence)? Three reasons:
 *
 *   1. **Esc backs out one step at a time.** A reducer transition lets
 *      us model "back" cleanly (Step.Provider → Step.Theme) without
 *      unwinding an async stack.
 *   2. **The runner is testable.** Driving the reducer with synthetic
 *      events (`pick`, `back`, `abort`) lets us assert the wizard ends
 *      in a known terminal state without simulating a real TTY.
 *   3. **The shape is a well-worn pattern.** A Step enum + per-step
 *      state is a standard onboarding-screen shape; we adopt the
 *      pattern, not anyone's code.
 */

import type { ThemeMode } from '../theme.js';
import type { ProviderEntry } from './providers.js';

export type Step =
  | 'welcome'
  | 'theme'
  | 'provider'
  | 'apiKey'
  | 'model'
  | 'mcp'
  | 'agentMd'
  | 'done';

/** Ordered list — used by the runner to compute "next" and "previous". */
export const STEP_ORDER: readonly Step[] = [
  'welcome',
  'theme',
  'provider',
  'apiKey',
  'model',
  'mcp',
  'agentMd',
  'done',
] as const;

/**
 * MCP transport pick. `skip` means "no MCP this session — local tools
 * only". Useful for users who want to try the agent before standing up
 * the brain. Matches the existing OFFLINE MODE behaviour the REPL
 * already handles.
 */
export type McpPick =
  | { kind: 'local-stdio' }
  | { kind: 'local-http'; apiKey?: string }
  | { kind: 'remote-http'; url: string; apiKey?: string }
  | { kind: 'skip' };

/**
 * Accumulated wizard state. Every step writes into this draft; only
 * the final commit phase touches disk. Aborting via `q` discards the
 * draft so a half-finished wizard never leaves a partial config.
 */
export interface WizardDraft {
  theme?: ThemeMode;
  provider?: ProviderEntry;
  /** Endpoint override — set when the user picks "Custom…" from the picker. */
  customEndpoint?: string;
  apiKey?: string;
  model?: string;
  mcp?: McpPick;
  writeAgentMd?: boolean;
}

/**
 * Non-fatal advisories the runner accumulates so the Done step can
 * surface them all at once ("you accepted an unusual key prefix" /
 * "MCP probe failed — saved anyway"). Better than printing each
 * warning at the time it's generated and losing it under the next
 * picker redraw.
 */
export interface WizardWarning {
  step: Step;
  message: string;
}

export interface WizardState {
  currentStep: Step;
  draft: WizardDraft;
  warnings: WizardWarning[];
  /** True once the Done step has committed the draft to disk. */
  committed: boolean;
  /** True if the user aborted via `q` / Ctrl+C — nothing was written. */
  aborted: boolean;
}

/**
 * Wizard events. The runner translates picker results / Esc keys into
 * one of these and feeds them through `reduceWizard`. The reducer is
 * pure so the test suite can drive the full state machine without
 * touching the TTY.
 */
export type WizardEvent =
  | { kind: 'advance'; patch: Partial<WizardDraft> }
  | { kind: 'back' }
  | { kind: 'abort' }
  | { kind: 'warn'; message: string }
  | { kind: 'commit' };

export function initWizardState(): WizardState {
  return {
    currentStep: 'welcome',
    draft: {},
    warnings: [],
    committed: false,
    aborted: false,
  };
}

/**
 * Compute the next step. Pure — used by `reduceWizard` and exposed for
 * tests + the runner's progress indicator ("step 3 of 7").
 */
export function nextStep(current: Step): Step | undefined {
  const idx = STEP_ORDER.indexOf(current);
  if (idx < 0 || idx === STEP_ORDER.length - 1) return undefined;
  return STEP_ORDER[idx + 1];
}

export function prevStep(current: Step): Step | undefined {
  const idx = STEP_ORDER.indexOf(current);
  if (idx <= 0) return undefined;
  return STEP_ORDER[idx - 1];
}

/**
 * Pure reducer. Every wizard transition must go through here so the
 * test suite can replay the same event sequence the runner emits.
 *
 * Contract:
 *   - `advance` applies the patch into the draft and steps forward;
 *     a no-op when called on the Done step.
 *   - `back` rewinds one step; a no-op on the first step.
 *   - `abort` lands the wizard in a terminal state with `aborted: true`
 *     and the draft preserved (caller may inspect for partial intent).
 *   - `warn` appends an advisory; doesn't move the step pointer.
 *   - `commit` flips `committed: true` on the Done step only.
 *
 * The reducer never throws — bad inputs are silently ignored so a
 * stray key event doesn't crash the wizard mid-render.
 */
export function reduceWizard(state: WizardState, event: WizardEvent): WizardState {
  if (state.aborted || state.committed) return state;

  switch (event.kind) {
    case 'advance': {
      const after = nextStep(state.currentStep);
      if (!after) return state;
      return {
        ...state,
        currentStep: after,
        draft: { ...state.draft, ...event.patch },
      };
    }
    case 'back': {
      const before = prevStep(state.currentStep);
      if (!before) return state;
      return { ...state, currentStep: before };
    }
    case 'abort':
      return { ...state, aborted: true };
    case 'warn':
      return {
        ...state,
        warnings: [
          ...state.warnings,
          { step: state.currentStep, message: event.message },
        ],
      };
    case 'commit':
      if (state.currentStep !== 'done') return state;
      return { ...state, committed: true };
  }
}
