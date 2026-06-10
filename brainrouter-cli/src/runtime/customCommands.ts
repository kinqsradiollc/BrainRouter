/**
 * CC-P4.1 — user-defined markdown slash commands (0.4.15 thread J).
 *
 * Drop a markdown file in `<workspace>/.brainrouter/commands/<name>.md` and
 * `/<name>` becomes a slash command: the file body is expanded into a prompt
 * and run as a normal agent turn. Frontmatter (optional) carries metadata:
 *
 *   ---
 *   description: Review the current diff for security issues
 *   ---
 *   Review the staged diff. Focus on: $ARGUMENTS
 *
 * Substitutions: `$ARGUMENTS` → everything after the command; `$1`..`$9` →
 * positional words. Unknown `$` tokens pass through untouched. Parsing and
 * expansion are pure (tested); only `loadCustomCommands` touches disk.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CustomCommandDef {
  /** Slash form, e.g. `/security-review`. */
  name: string;
  description: string;
  /** Prompt template (file body without frontmatter). */
  body: string;
  filePath: string;
}

/** Parse one command file's raw text (frontmatter + body). Pure. */
export function parseCustomCommand(fileName: string, raw: string, filePath = fileName): CustomCommandDef | null {
  const base = path.basename(fileName, '.md');
  if (!base || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base)) return null;

  let description = '';
  let body = raw;
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    const descLine = fm[1].split(/\r?\n/).find((l) => /^description\s*:/.test(l.trim()));
    if (descLine) description = descLine.replace(/^\s*description\s*:\s*/, '').trim();
  }
  body = body.trim();
  if (!body) return null;
  return {
    name: `/${base}`,
    description: description || `Custom command from ${path.basename(filePath)}`,
    body,
    filePath,
  };
}

/** Expand `$ARGUMENTS` and `$1`..`$9` in a template. Pure. */
export function expandCommandBody(body: string, args: string[]): string {
  const joined = args.join(' ').trim();
  return body
    .replace(/\$ARGUMENTS\b/g, joined)
    .replace(/\$([1-9])\b/g, (_m, d) => args[Number(d) - 1] ?? '');
}

/** Directory custom commands live in. */
export function customCommandsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'commands');
}

/** Load all custom command defs for a workspace. Returns [] when none. */
export function loadCustomCommands(workspaceRoot: string): CustomCommandDef[] {
  const dir = customCommandsDir(workspaceRoot);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const defs: CustomCommandDef[] = [];
  for (const f of files.sort()) {
    try {
      const full = path.join(dir, f);
      const def = parseCustomCommand(f, fs.readFileSync(full, 'utf-8'), full);
      if (def) defs.push(def);
    } catch { /* unreadable file — skip */ }
  }
  return defs;
}

/** Find a def by its slash form (exact, case-sensitive). Pure. */
export function findCustomCommand(defs: CustomCommandDef[], command: string): CustomCommandDef | undefined {
  return defs.find((d) => d.name === command);
}
