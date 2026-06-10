/**
 * CC-P3.2 — declarative permission rules (0.4.15 thread I).
 *
 * `cli.permissions` in config.json holds two pattern lists:
 *
 *   "permissions": {
 *     "deny":  ["run_command(rm *)", "fetch_url(*internal.corp*)"],
 *     "allow": ["run_command(git status*)", "edit_file(src/**)"]
 *   }
 *
 * A pattern is `tool` (any call to that tool) or `tool(globish)` where the
 * glob matches the call's PRIMARY argument (`run_command`→command,
 * file tools→path, `fetch_url`→url). `*` matches any run of characters
 * (including `/`); `**` is accepted and equivalent. Matching is
 * case-sensitive on tool names, case-insensitive on the argument.
 *
 * Semantics at the execution-policy gate:
 *   - a DENY match throws before the tool runs (deny always wins);
 *   - an ALLOW match downgrades an `ask` decision to `allow` (fewer prompts)
 *     but NEVER overrides a mode-based deny — rules can't escalate read mode
 *     into writes.
 * Pure → unit-tested.
 */

export interface PermissionRules {
  allow?: string[];
  deny?: string[];
}

interface ParsedRule {
  tool: string;
  /** Lower-cased glob for the primary argument; null = any args. */
  argGlob: string | null;
}

/** Parse `tool` or `tool(pattern)` into its parts. Returns null for garbage. Pure. */
export function parseRule(rule: string): ParsedRule | null {
  const trimmed = (rule ?? '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*(?:\((.*)\))?$/);
  if (!m) return null;
  const tool = m[1];
  const argGlob = m[2] !== undefined ? m[2].trim().toLowerCase() : null;
  return { tool, argGlob: argGlob === '' ? null : argGlob };
}

function globToRegExp(glob: string): RegExp {
  // ** and * both match any run of characters; everything else is literal.
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*(\\\*)?/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True iff `rule` matches this tool call. Pure. */
export function ruleMatches(rule: string, toolName: string, argText: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (parsed.tool !== toolName) return false;
  if (parsed.argGlob === null) return true;
  return globToRegExp(parsed.argGlob).test((argText ?? '').toLowerCase());
}

/**
 * Evaluate the rule lists for a call. Returns 'deny' | 'allow' | null
 * (no rule matched). Deny wins over allow. Pure.
 */
export function evaluatePermissionRules(
  rules: PermissionRules | undefined,
  toolName: string,
  argText: string,
): 'allow' | 'deny' | null {
  if (!rules) return null;
  for (const r of rules.deny ?? []) if (ruleMatches(r, toolName, argText)) return 'deny';
  for (const r of rules.allow ?? []) if (ruleMatches(r, toolName, argText)) return 'allow';
  return null;
}

/** The argument a rule's glob applies to, per tool. Pure. */
export function primaryArgText(toolName: string, args: Record<string, unknown> | null | undefined): string {
  if (!args) return '';
  switch (toolName) {
    case 'run_command':
      return String((args as { command?: unknown }).command ?? '');
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return String((args as { path?: unknown }).path ?? '');
    case 'fetch_url':
      return String((args as { url?: unknown }).url ?? '');
    case 'apply_patch':
      return String((args as { patch?: unknown }).patch ?? '').slice(0, 500);
    default: {
      const a = args as Record<string, unknown>;
      const first = a.command ?? a.path ?? a.url ?? a.query ?? '';
      return String(first ?? '');
    }
  }
}

/** Parse a comma-separated tool list flag ("run_command, fetch_url") → names. Pure. */
export function parseToolList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

