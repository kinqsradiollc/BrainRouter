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
 *
 * CC-SAFETY-B3 — a rule's glob may reference the home dir or the workspace root
 * via `~`, `$HOME`, or `$WORKSPACE` (the same tokens sandbox roots accept), so
 * `read_file(~/.ssh/**)` / `read_file($HOME/.env)` match the resolved absolute
 * path a tool call carries. Expansion happens at parse time — see `expandPathVars`.
 * Pure → unit-tested.
 */

import os from 'node:os';

export interface PermissionRules {
  allow?: string[];
  deny?: string[];
}

/**
 * CC-SAFETY-B3 — expand `~`, `$HOME`, and `$WORKSPACE` in a path-ish rule glob
 * to absolute prefixes, so a config rule written with a variable matches the
 * absolute path a tool call actually carries. A glob with none of these tokens
 * (a bare `*`, a URL pattern) is returned unchanged. Pure — `home`/`workspace`
 * are injectable (default to the live env) for deterministic tests.
 *
 *   ~/.ssh/**       → /Users/me/.ssh/**
 *   $HOME/.env      → /Users/me/.env
 *   $WORKSPACE/dist → /repo/dist
 */
export function expandPathVars(
  glob: string,
  vars?: { home?: string; workspace?: string },
): string {
  if (!glob) return glob;
  const home = (vars?.home ?? os.homedir() ?? '').replace(/[/\\]+$/, '');
  const workspace = (vars?.workspace ?? process.env.WORKSPACE ?? process.cwd() ?? '').replace(/[/\\]+$/, '');
  let out = glob;
  // Leading `~` (either `~` alone or `~/...`) → home. Only a LEADING `~` is a
  // home reference; a mid-string `~` stays literal.
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = home + out.slice(1);
  // $HOME / ${HOME} and $WORKSPACE / ${WORKSPACE}, anywhere in the pattern.
  if (home) out = out.replace(/\$\{?HOME\}?/g, home);
  if (workspace) out = out.replace(/\$\{?WORKSPACE\}?/g, workspace);
  return out;
}

interface ParsedRule {
  tool: string;
  /** Lower-cased glob for the primary argument; null = any args. */
  argGlob: string | null;
}

/** Parse `tool` or `tool(pattern)` into its parts. Returns null for garbage. Pure.
 * CC-SAFETY-B3 — `~` / `$HOME` / `$WORKSPACE` in the glob are expanded to absolute
 * prefixes (before lowercasing) so a variable-written rule matches the resolved path. */
export function parseRule(rule: string, vars?: { home?: string; workspace?: string }): ParsedRule | null {
  const trimmed = (rule ?? '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*(?:\((.*)\))?$/);
  if (!m) return null;
  const tool = m[1];
  const argGlob = m[2] !== undefined ? expandPathVars(m[2].trim(), vars).toLowerCase() : null;
  return { tool, argGlob: argGlob === '' ? null : argGlob };
}

function globToRegExp(glob: string): RegExp {
  // ** and * both match any run of characters; everything else is literal.
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*(\\\*)?/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True iff `rule` matches this tool call. Pure.
 * `vars` (CC-SAFETY-B3) supplies `~`/`$HOME`/`$WORKSPACE` expansion for the glob. */
export function ruleMatches(
  rule: string,
  toolName: string,
  argText: string,
  vars?: { home?: string; workspace?: string },
): boolean {
  const parsed = parseRule(rule, vars);
  if (!parsed) return false;
  if (parsed.tool !== toolName) return false;
  if (parsed.argGlob === null) return true;
  return globToRegExp(parsed.argGlob).test((argText ?? '').toLowerCase());
}

/**
 * Evaluate the rule lists for a call. Returns 'deny' | 'allow' | null
 * (no rule matched). Deny wins over allow. Pure.
 *
 * `vars` (CC-SAFETY-B3) is threaded into each rule's glob expansion so a rule
 * like `read_file(~/.ssh/**)` matches the resolved absolute path a tool carries.
 */
export function evaluatePermissionRules(
  rules: PermissionRules | undefined,
  toolName: string,
  argText: string,
  vars?: { home?: string; workspace?: string },
): 'allow' | 'deny' | null {
  if (!rules) return null;
  for (const r of rules.deny ?? []) if (ruleMatches(r, toolName, argText, vars)) return 'deny';
  for (const r of rules.allow ?? []) if (ruleMatches(r, toolName, argText, vars)) return 'allow';
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

