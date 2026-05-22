import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceStateRoot } from './cliState.js';

/**
 * Hookify-style markdown hooks — no-code behavior guards expressed as YAML
 * frontmatter on a `.md` file.
 *
 * Hooks live as `.md` files under
 *   ~/.brainrouter/workspaces/<encoded>/hooks/
 * with YAML frontmatter describing the event, regex pattern(s), and action.
 * This gives users a no-code path to install behavior guards without editing
 * shell hooks. Pre-2026-05-21 builds stored these inside the workspace itself
 * (`<workspace>/.brainrouter/hooks/`); those files are auto-migrated to the
 * new home on first run by `cliState.getCliStateDir`.
 *
 * Example file `hooks/block-rm-rf.md`:
 *
 *   ---
 *   name: block-rm-rf
 *   enabled: true
 *   event: bash
 *   pattern: rm\s+-rf
 *   action: block
 *   ---
 *
 *   ⚠️ Dangerous rm command blocked. Verify the path is correct.
 */

export type HookifyEvent = 'bash' | 'file' | 'stop' | 'prompt' | 'all';
export type HookifyAction = 'warn' | 'block';

export interface HookifyCondition {
  field: string;
  operator: 'regex_match' | 'contains' | 'equals' | 'not_contains' | 'starts_with' | 'ends_with';
  pattern: string;
}

export interface HookifyRule {
  /** Stable identifier (filename without extension). */
  id: string;
  /** Human-readable rule name from frontmatter. */
  name: string;
  enabled: boolean;
  event: HookifyEvent;
  /** Primary regex shortcut (mutually exclusive with conditions). */
  pattern?: string;
  /** Composite conditions; all must match for the rule to fire. */
  conditions?: HookifyCondition[];
  action: HookifyAction;
  /** Markdown body shown to the user when the rule fires. */
  message: string;
  /** Absolute path to the source file (so /hookify list can cite it). */
  sourcePath: string;
}

function hookDir(workspaceRoot: string): string {
  return path.join(getWorkspaceStateRoot(workspaceRoot), 'hooks');
}

export function ensureHookDir(workspaceRoot: string): string {
  const dir = hookDir(workspaceRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listHookifyRules(workspaceRoot: string): HookifyRule[] {
  const dir = hookDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const out: HookifyRule[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const full = path.join(dir, entry);
    try {
      const rule = parseHookifyFile(full);
      if (rule) out.push(rule);
    } catch {
      // Skip malformed rule files; surfacing the error is the REPL's job.
    }
  }
  return out;
}

export function parseHookifyFile(filePath: string): HookifyRule | null {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  const frontmatter = match[1];
  const body = match[2].trim();
  const meta: Record<string, any> = {};
  let currentList: HookifyCondition[] | null = null;
  let currentCond: HookifyCondition | null = null;
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('-') && currentList) {
      const inner = line.trim().slice(1).trim();
      currentCond = { field: '', operator: 'regex_match', pattern: '' };
      const [k, ...rest] = inner.split(':');
      if (rest.length > 0) (currentCond as any)[k.trim()] = rest.join(':').trim();
      currentList.push(currentCond);
      continue;
    }
    if (line.startsWith('  ') && currentCond) {
      const [k, ...rest] = line.trim().split(':');
      if (rest.length > 0) (currentCond as any)[k.trim()] = rest.join(':').trim();
      continue;
    }
    const [k, ...rest] = line.split(':');
    if (rest.length === 0) continue;
    const key = k.trim();
    const value = rest.join(':').trim();
    if (key === 'conditions') {
      currentList = [];
      meta.conditions = currentList;
      currentCond = null;
      continue;
    }
    currentList = null;
    currentCond = null;
    meta[key] = value;
  }
  const id = path.basename(filePath).replace(/\.md$/, '');
  if (!meta.event) return null;
  return {
    id,
    name: typeof meta.name === 'string' ? meta.name : id,
    enabled: meta.enabled === undefined ? true : meta.enabled === 'true' || meta.enabled === true,
    event: meta.event as HookifyEvent,
    pattern: typeof meta.pattern === 'string' ? meta.pattern : undefined,
    conditions: Array.isArray(meta.conditions) && meta.conditions.length > 0 ? meta.conditions : undefined,
    action: (meta.action === 'block' ? 'block' : 'warn'),
    message: body,
    sourcePath: filePath,
  };
}

export interface HookifyContext {
  /** The tool name being invoked, normalized: run_command → bash, write_file/edit_file → file, etc. */
  event: HookifyEvent;
  fields: Record<string, string>;
}

export interface HookifyMatch {
  rule: HookifyRule;
  /** "warn" surfaces a message; "block" denies the operation. */
  action: HookifyAction;
}

/**
 * Map a brainrouter tool invocation to the hookify event taxonomy. Returns
 * the canonical event and the field bag that condition checks will probe.
 */
export function buildHookifyContext(toolName: string, args: Record<string, any>): HookifyContext {
  if (toolName === 'run_command') {
    return { event: 'bash', fields: { command: String(args.command ?? '') } };
  }
  if (toolName === 'write_file') {
    return {
      event: 'file',
      fields: {
        file_path: String(args.path ?? ''),
        content: String(args.content ?? ''),
        new_text: String(args.content ?? ''),
      },
    };
  }
  if (toolName === 'edit_file') {
    return {
      event: 'file',
      fields: {
        file_path: String(args.path ?? ''),
        old_text: String(args.targetContent ?? ''),
        new_text: String(args.replacementContent ?? ''),
      },
    };
  }
  if (toolName === 'apply_patch') {
    return { event: 'file', fields: { new_text: String(args.patch ?? '') } };
  }
  return { event: 'all', fields: {} };
}

export function buildPromptContext(prompt: string): HookifyContext {
  return { event: 'prompt', fields: { user_prompt: prompt } };
}

export function buildStopContext(transcript: string): HookifyContext {
  return { event: 'stop', fields: { transcript } };
}

function fieldMatches(value: string, op: HookifyCondition['operator'], pattern: string): boolean {
  if (!pattern) return false;
  switch (op) {
    case 'regex_match':
      try { return new RegExp(pattern).test(value); } catch { return false; }
    case 'contains':
      return value.includes(pattern);
    case 'equals':
      return value === pattern;
    case 'not_contains':
      return !value.includes(pattern);
    case 'starts_with':
      return value.startsWith(pattern);
    case 'ends_with':
      return value.endsWith(pattern);
    default:
      return false;
  }
}

export function evaluateHookify(rules: HookifyRule[], ctx: HookifyContext): HookifyMatch[] {
  const out: HookifyMatch[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.event !== 'all' && rule.event !== ctx.event) continue;
    let matched = false;
    if (rule.pattern) {
      const haystack = Object.values(ctx.fields).join('\n');
      try { matched = new RegExp(rule.pattern).test(haystack); } catch { matched = false; }
    }
    if (!matched && rule.conditions && rule.conditions.length > 0) {
      matched = rule.conditions.every((c) => {
        const value = ctx.fields[c.field] ?? '';
        return fieldMatches(value, c.operator, c.pattern);
      });
    }
    if (matched) out.push({ rule, action: rule.action });
  }
  return out;
}

export function createHookifyRule(
  workspaceRoot: string,
  rule: { name: string; event: HookifyEvent; pattern?: string; action?: HookifyAction; message: string; conditions?: HookifyCondition[]; enabled?: boolean },
): HookifyRule {
  const dir = ensureHookDir(workspaceRoot);
  const slug = rule.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `rule-${Date.now()}`;
  const file = path.join(dir, `${slug}.md`);
  const lines: string[] = ['---'];
  lines.push(`name: ${rule.name}`);
  lines.push(`enabled: ${rule.enabled === false ? 'false' : 'true'}`);
  lines.push(`event: ${rule.event}`);
  if (rule.pattern) lines.push(`pattern: ${rule.pattern}`);
  if (rule.action) lines.push(`action: ${rule.action}`);
  if (rule.conditions && rule.conditions.length > 0) {
    lines.push('conditions:');
    for (const c of rule.conditions) {
      lines.push(`  - field: ${c.field}`);
      lines.push(`    operator: ${c.operator}`);
      lines.push(`    pattern: ${c.pattern}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(rule.message.trim());
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  const parsed = parseHookifyFile(file);
  if (!parsed) throw new Error(`Failed to read back created rule at ${file}`);
  return parsed;
}

export function deleteHookifyRule(workspaceRoot: string, id: string): boolean {
  const dir = hookDir(workspaceRoot);
  const file = path.join(dir, `${id}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function toggleHookifyRule(workspaceRoot: string, id: string, enabled: boolean): boolean {
  const dir = hookDir(workspaceRoot);
  const file = path.join(dir, `${id}.md`);
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, 'utf8');
  const next = content.replace(/(\nenabled:\s*)(true|false)/, `$1${enabled ? 'true' : 'false'}`);
  if (next === content) {
    const inserted = content.replace(/^---\n/, `---\nenabled: ${enabled ? 'true' : 'false'}\n`);
    fs.writeFileSync(file, inserted, 'utf8');
  } else {
    fs.writeFileSync(file, next, 'utf8');
  }
  return true;
}
