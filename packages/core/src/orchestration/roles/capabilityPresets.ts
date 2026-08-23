// ADR-041 A41-9 — capability presets. A role used to carry its access tier (and
// the fleet sandbox flag) inline. A preset is that bundle named and made reusable:
// the four access shapes the built-in roles actually use, defined ONCE so a role
// (or, later, a session scope) consumes a preset by name instead of restating
// `defaultAccess`/`forceSandbox`. Byte-neutral: each preset encodes the exact tier
// the consuming roles already had.
import type { AccessMode } from '../../exec/policy/execPolicy.js';

export interface CapabilityPreset {
  /** Stable preset id a role/scope references. */
  name: string;
  /** Default access tier this preset grants (read ⊂ write ⊂ shell). */
  access: AccessMode;
  /**
   * Force the OS sandbox + network-deny + secret-env scrubbing on, un-opt-out-able
   * (unattended fleet execution — HONK-H0). Absent = follow the normal knobs.
   */
  forceSandbox?: boolean;
}

export const CAPABILITY_PRESETS = {
  /** Investigate/design/review — never mutates the workspace. */
  readonly: { name: 'readonly', access: 'read' },
  /** Implement — edits files, no shell. */
  implementer: { name: 'implementer', access: 'write' },
  /** Verify — runs tests/typechecks/shell. */
  executor: { name: 'executor', access: 'shell' },
  /** Unattended fleet — shell, with the sandbox forced on. */
  'sandboxed-executor': { name: 'sandboxed-executor', access: 'shell', forceSandbox: true },
} satisfies Record<string, CapabilityPreset>;

export type CapabilityPresetName = keyof typeof CAPABILITY_PRESETS;

/**
 * The role fields a preset supplies, ready to spread into a role definition so the
 * access tier lives in the preset, not restated per role. `forceSandbox` is only
 * present when the preset sets it, so a role's shape stays identical to before.
 */
export function presetAccess(name: CapabilityPresetName): { defaultAccess: AccessMode; forceSandbox?: boolean } {
  const preset: CapabilityPreset = CAPABILITY_PRESETS[name];
  return preset.forceSandbox
    ? { defaultAccess: preset.access, forceSandbox: true }
    : { defaultAccess: preset.access };
}
