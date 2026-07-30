// Workflow automation knobs (cli.automation.*): the turn-end
// Requirement→Plan→Track→Sprint pipeline. All default OFF; these helpers are the
// first-class toggle surface (vs hand-editing config.json). Kept PURE (config-in,
// config-mutated) so they unit-test without a CommandContext.
import type { CommandContext } from '../_context.js';
import { TRUE_WORDS, FALSE_WORDS } from './shared.js';

type AutomationCfg = NonNullable<NonNullable<CommandContext['config']['cli']>['automation']>;

function automationBlock(cfg: CommandContext['config']): AutomationCfg {
  cfg.cli = cfg.cli ?? {};
  cfg.cli.automation = cfg.cli.automation ?? {};
  return cfg.cli.automation as AutomationCfg;
}

/** Read the current state of an automation key as a display string. */
export function readAutomationKnob(cfg: CommandContext['config'], key: string): string {
  const a = cfg.cli?.automation ?? {};
  const tier = (stage?: { enabled?: boolean; autopilot?: boolean }): string =>
    !stage?.enabled ? 'off' : stage.autopilot ? 'autopilot' : 'propose';
  switch (key) {
    case 'automation': return a.enabled ? 'on' : 'off';
    case 'automation.requirements': return tier(a.requirements);
    case 'automation.sync': return a.sync?.enabled ? 'on' : 'off';
    case 'automation.sprints': return tier(a.sprints);
    default: return '(unknown)';
  }
}

/**
 * Apply an automation key=value to `cfg` (mutating cli.automation.*). Tiered
 * stages accept off | propose (alias on) | autopilot; boolean stages on|off.
 * Returns ok + a human message, or a reason on rejection. Pure — the caller
 * persists via saveConfig and refreshes the knob cache.
 */
export function applyAutomationKnob(
  cfg: CommandContext['config'],
  key: string,
  value: string,
): { ok: true; message: string } | { ok: false; reason: string } {
  const v = value.toLowerCase().trim();
  const a = automationBlock(cfg);
  const isTrue = TRUE_WORDS.includes(v);
  const isFalse = FALSE_WORDS.includes(v);
  switch (key) {
    case 'automation': {
      if (!isTrue && !isFalse) return { ok: false, reason: `automation must be on|off (got "${value}")` };
      a.enabled = isTrue;
      return { ok: true, message: isTrue
        ? 'automation → on (master switch; enable individual stages too)'
        : 'automation → off (master switch — nothing fires)' };
    }
    case 'automation.requirements': {
      if (isFalse) { a.requirements = { ...a.requirements, enabled: false }; return { ok: true, message: 'automation.requirements → off' }; }
      if (isTrue || v === 'propose') { a.requirements = { ...a.requirements, enabled: true, autopilot: false }; return { ok: true, message: 'automation.requirements → propose (draft + one-click promote)' }; }
      if (v === 'autopilot') { a.requirements = { ...a.requirements, enabled: true, autopilot: true }; return { ok: true, message: 'automation.requirements → autopilot (auto-create ready, cascade runs)' }; }
      return { ok: false, reason: `automation.requirements must be off|propose|autopilot (got "${value}")` };
    }
    case 'automation.sync': {
      if (!isTrue && !isFalse) return { ok: false, reason: `automation.sync must be on|off (got "${value}")` };
      a.sync = { ...a.sync, enabled: isTrue };
      return { ok: true, message: `automation.sync → ${isTrue ? 'on' : 'off'} (plan→Track items + code links)` };
    }
    case 'automation.sprints': {
      if (isFalse) { a.sprints = { ...a.sprints, enabled: false }; return { ok: true, message: 'automation.sprints → off' }; }
      if (isTrue || v === 'propose') { a.sprints = { ...a.sprints, enabled: true, autopilot: false }; return { ok: true, message: 'automation.sprints → propose (suggest only, no mutation)' }; }
      if (v === 'autopilot') { a.sprints = { ...a.sprints, enabled: true, autopilot: true }; return { ok: true, message: 'automation.sprints → autopilot (create/assign/complete; never auto-starts)' }; }
      return { ok: false, reason: `automation.sprints must be off|propose|autopilot (got "${value}")` };
    }
    default: return { ok: false, reason: `unknown automation key "${key}"` };
  }
}
