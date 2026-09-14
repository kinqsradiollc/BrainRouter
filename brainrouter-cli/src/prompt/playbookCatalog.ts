/**
 * ADR-047 D3 (P3) — playbooks: one packaged, parameterized, schedulable
 * automation unit.
 *
 * A playbook is deliberately NOT new machinery — it is a single typed artifact
 * that COMPOSES surfaces that already exist: a prompt or skill reference, a set
 * of typed parameters, a bounded tool policy, and an optional schedule. It lives
 * as a committable file (`<ws>/.brainrouter/playbooks/<name>.md`), so "sharing
 * one" is committing it, and the plugin marketplace is the later distribution
 * channel (the same skill-root discovery already flows plugin files into scope).
 *
 * This module is the PURE half — parse, validate, scaffold, substitute — with no
 * agent/turn coupling. The `/playbook` command composes it onto the skill runner,
 * the schedule ticker, and the turn runner. Frontmatter parsing is the same
 * dependency-free regex contract skills use (no YAML lib), and typed parameters —
 * the one piece nothing in the codebase provided — are validated here.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  extractFrontmatterBlock,
  parseAllowedToolsFrontmatter,
  parseDisallowedToolsFrontmatter,
} from './skillCatalog.js';

export type PlaybookParamType = 'string' | 'number' | 'boolean';

export interface PlaybookParam {
  name: string;
  type: PlaybookParamType;
  required: boolean;
}

export interface Playbook {
  name: string;
  description?: string;
  /** Optional skill whose body is executed; when absent the markdown body IS the prompt. */
  skill?: string;
  /** The markdown body below the frontmatter — the prompt (or extra input to the skill). */
  body: string;
  params: PlaybookParam[];
  allowedTools?: string[];
  disallowedTools: string[];
  /** Optional default cron expression for `/playbook schedule`. */
  schedule?: string;
  /** Absolute path the playbook was loaded from (empty for an in-memory parse). */
  path: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidPlaybookName(name: string): boolean {
  return NAME_RE.test(name);
}

function frontmatterScalar(block: string, key: string): string | undefined {
  const m = block.split(/\r?\n/).find((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (!m) return undefined;
  const value = m.replace(new RegExp(`^${key}\\s*:`), '').trim().replace(/^['"]|['"]$/g, '');
  return value || undefined;
}

/**
 * Parse the typed-parameter block — the piece with no existing substrate.
 * Block form (indented lines under `params:`), each `<name>: <type> [required]`:
 *
 *   params:
 *     ticket: string required
 *     environment: string
 *
 * Unknown types default to `string`; a malformed line is skipped. Kept
 * regex-simple on purpose, matching the frontmatter contract skills already use.
 */
export function parsePlaybookParams(block: string): PlaybookParam[] {
  const lines = block.split(/\r?\n/);
  const idx = lines.findIndex((line) => /^params\s*:/.test(line));
  if (idx < 0) return [];
  const out: PlaybookParam[] = [];
  const seen = new Set<string>();
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s+\S/.test(line)) break; // first non-indented line ends the block
    const m = line.trim().match(/^-?\s*([A-Za-z0-9_-]+)\s*:\s*(\w+)?\s*(required)?\s*$/);
    if (!m) continue;
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const type: PlaybookParamType = m[2] === 'number' || m[2] === 'boolean' ? m[2] : 'string';
    out.push({ name, type, required: m[3] === 'required' });
  }
  return out;
}

/** Parse a playbook from its raw file text. `name` falls back to the frontmatter/file name. */
export function parsePlaybook(raw: string, name: string, filePath = ''): Playbook {
  const block = extractFrontmatterBlock(raw);
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  return {
    name: frontmatterScalar(block, 'name') ?? name,
    description: frontmatterScalar(block, 'description'),
    skill: frontmatterScalar(block, 'skill'),
    body,
    params: parsePlaybookParams(block),
    allowedTools: parseAllowedToolsFrontmatter(raw),
    disallowedTools: parseDisallowedToolsFrontmatter(raw),
    schedule: frontmatterScalar(block, 'schedule'),
    path: filePath,
  };
}

function playbooksDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'playbooks');
}

/** Load one playbook by name, or undefined when it does not exist / cannot be read. */
export function loadPlaybook(workspaceRoot: string, name: string): Playbook | undefined {
  if (!isValidPlaybookName(name)) return undefined;
  const file = path.join(playbooksDir(workspaceRoot), `${name}.md`);
  try {
    if (!fs.existsSync(file)) return undefined;
    return parsePlaybook(fs.readFileSync(file, 'utf8'), name, file);
  } catch {
    return undefined;
  }
}

/** Every playbook in the workspace, sorted by name. */
export function listPlaybooks(workspaceRoot: string): Playbook[] {
  const dir = playbooksDir(workspaceRoot);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: Playbook[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    const pb = loadPlaybook(workspaceRoot, name);
    if (pb) out.push(pb);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ScaffoldPlaybookResult { path: string; created: boolean; }

function renderPlaybookTemplate(name: string): string {
  return `---
name: ${name}
description: One-line summary of what this playbook does.
# skill: <skill-name>          # optional — run a skill's body instead of the prose below
params:
  ticket: string required
  environment: string
allowed-tools: [read_file, run_command]
# schedule: "0 9 * * 1"         # optional default cron (Mondays 09:00)
---

Describe the task here. Reference parameters with {{ticket}} and {{environment}}.

For example: investigate ticket {{ticket}} in the {{environment}} environment and
summarize the root cause.
`;
}

/** Scaffold `<ws>/.brainrouter/playbooks/<name>.md`, never overwriting unless `force`. */
export function scaffoldPlaybook(workspaceRoot: string, name: string, opts: { force?: boolean } = {}): ScaffoldPlaybookResult {
  if (!isValidPlaybookName(name)) {
    throw new Error(`Invalid playbook name "${name}" — use letters, digits, dashes or underscores.`);
  }
  const dir = playbooksDir(workspaceRoot);
  const file = path.join(dir, `${name}.md`);
  if (fs.existsSync(file) && !opts.force) return { path: file, created: false };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, renderPlaybookTemplate(name), 'utf8');
  return { path: file, created: true };
}

export type ParamResolution =
  | { ok: true; values: Record<string, string> }
  | { ok: false; missing: string[]; errors: string[] };

/**
 * Validate provided `--param k=v` values against the playbook's typed schema:
 * every `required` param must be present, and each value must satisfy its
 * declared type (numbers finite, booleans a recognized literal). Unknown
 * provided keys are dropped (a typo silently doing nothing is worse than a
 * clear error — but a declared param is the contract, so we only carry those).
 */
export function resolvePlaybookParams(playbook: Playbook, provided: Record<string, string>): ParamResolution {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const errors: string[] = [];
  for (const param of playbook.params) {
    const raw = provided[param.name];
    if (raw === undefined || raw === '') {
      if (param.required) missing.push(param.name);
      continue;
    }
    if (param.type === 'number' && !Number.isFinite(Number(raw))) {
      errors.push(`param "${param.name}" must be a number (got "${raw}")`);
      continue;
    }
    if (param.type === 'boolean' && !/^(true|false|yes|no|1|0)$/i.test(raw)) {
      errors.push(`param "${param.name}" must be a boolean (true/false)`);
      continue;
    }
    values[param.name] = raw;
  }
  if (missing.length || errors.length) return { ok: false, missing, errors };
  return { ok: true, values };
}

/**
 * Substitute `{{name}}` (and `{{ name }}`) in the body with resolved values, and
 * append a compact parameters block so the agent sees every input even when the
 * body does not reference it by hand.
 */
export function applyPlaybookParams(playbook: Playbook, values: Record<string, string>): string {
  let out = playbook.body;
  for (const [key, value] of Object.entries(values)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
  }
  const entries = Object.entries(values);
  if (entries.length > 0) {
    out += `\n\n## Parameters\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
  }
  return out;
}

/** The slash command a schedule fires to run this playbook with the given params. */
export function playbookRunCommand(name: string, values: Record<string, string>): string {
  const params = Object.entries(values).map(([k, v]) => `--param ${k}=${v}`).join(' ');
  return `/playbook run ${name}${params ? ` ${params}` : ''}`;
}

/** Parse `--param k=v` tokens from a command's argument list. */
export function parseParamArgs(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--param') continue;
    const kv = args[i + 1];
    if (!kv) continue;
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    out[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
    i++;
  }
  return out;
}
