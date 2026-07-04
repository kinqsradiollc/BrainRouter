/**
 * MC-B3 — pure helpers behind `brainrouter automations {list|enable|disable}`
 * (kept side-effect-free so argument validation and the listing render are
 * unit-testable without touching a workspace on disk).
 */
import type { AutomationRule } from '@kinqs/brainrouter-core/triggers';

export const AUTOMATION_COMMAND_ACTIONS = ['list', 'enable', 'disable'] as const;
export type AutomationCommandAction = (typeof AUTOMATION_COMMAND_ACTIONS)[number];

/**
 * Validate the `[action] [id]` pair. Returns the user-facing error line, or
 * null when the invocation may proceed. `list` needs no id; enable/disable
 * refuse to run without one (no "toggle everything" footgun).
 */
export function validateAutomationsInvocation(action: string, id?: string): string | null {
  if (!AUTOMATION_COMMAND_ACTIONS.includes(action as AutomationCommandAction)) {
    return `Unknown automations action "${action}". Use: list | enable <id> | disable <id>.`;
  }
  if ((action === 'enable' || action === 'disable') && !id?.trim()) {
    return `Usage: brainrouter automations ${action} <rule-id>  (find ids with: brainrouter automations list)`;
  }
  return null;
}

/** Render the registry listing (plain text; the entry layer adds color). */
export function formatAutomationsList(rules: AutomationRule[]): string {
  if (rules.length === 0) {
    return [
      'No automation rules found.',
      'Add one under .brainrouter/automations/<id>.md with frontmatter:',
      '  ---',
      '  on: github.issue.labeled',
      "  when: \"label == 'brainrouter'\"",
      '  do: build',
      '  ---',
    ].join('\n');
  }
  const lines: string[] = [`Automation rules (${rules.length}):`];
  for (const rule of rules) {
    const state = rule.enabled ? '[on] ' : '[off]';
    const when = rule.when ? `  when ${rule.when}` : '';
    lines.push(`  ${state} ${rule.id}  on ${rule.on}${when}  do ${rule.do}`);
  }
  return lines.join('\n');
}
