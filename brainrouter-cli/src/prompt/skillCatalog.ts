import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';

const requireFromHere = createRequire(import.meta.url);

export interface SkillListItem {
  name: string;
  scope?: string;
  category?: string;
  description?: string;
  source?: 'mcp' | 'filesystem';
  /**
   * CC-SKILLS-D2 — set when the SAME skill name was found in more than one
   * BrainRouter skill root. `true` on the entry that WON precedence (the one
   * actually loaded). The shadowed copies are surfaced via `shadowedBy`.
   */
  collides?: boolean;
  /**
   * CC-SKILLS-D2 — scopes of the lower-precedence roots this entry shadows,
   * e.g. `['bundled']` when a workspace skill hides a bundled one of the same
   * name. Empty/undefined when there is no collision.
   */
  shadowedBy?: string[];
  /** CC-SKILLS-D2 — `<scope>:<name>` disambiguated label for display. */
  qualifiedName?: string;
}

const WORKSPACE_SKILL_ROOTS = ['skills', '.brainrouter/skills'];

export function listFilesystemSkills(workspaceRoot: string): SkillListItem[] {
  const knobs = getCliKnobs();
  // CC-CONFIG-A1 — safe mode loads NO skills at all (isolate a bad skill).
  if (knobs.safeMode) return [];
  // First entry per name WINS (roots are ordered workspace → local → bundled),
  // consistent with resolveSkill's precedence. CC-SKILLS-D2: we no longer drop
  // the shadowed copies silently — we record the collision so the /skills
  // listing can render `<scope>:<name>` and mark what's hidden.
  const winners = new Map<string, SkillListItem>();
  const shadowScopes = new Map<string, string[]>();
  // CC-CONFIG-A6 — optionally hide BUNDLED skills (shipped with the install),
  // leaving only workspace-authored skill roots (skills/, .brainrouter/skills).
  for (const root of skillSearchRoots(workspaceRoot, { includeBundled: !knobs.skillsHideBundled })) {
    if (!fs.existsSync(root)) continue;
    const scope = inferRootScope(root, workspaceRoot);
    for (const filePath of findSkillFiles(root)) {
      const parsed = parseSkillFile(filePath);
      if (!parsed) continue;
      const rel = path.relative(root, filePath);
      const category = rel.split(path.sep)[0] || 'uncategorized';
      if (!winners.has(parsed.name)) {
        winners.set(parsed.name, {
          name: parsed.name,
          category,
          description: parsed.description,
          scope,
          source: 'filesystem',
          qualifiedName: `${scope}:${parsed.name}`,
        });
      } else {
        // A same-named skill in a LOWER-precedence root — record it as shadowed
        // (dedupe scopes so two bundled roots don't list `bundled` twice).
        const list = shadowScopes.get(parsed.name) ?? [];
        if (!list.includes(scope)) list.push(scope);
        shadowScopes.set(parsed.name, list);
      }
    }
  }
  for (const [name, hidden] of shadowScopes) {
    const winner = winners.get(name);
    if (winner) {
      winner.collides = true;
      winner.shadowedBy = hidden;
    }
  }
  return Array.from(winners.values()).sort(sortSkills);
}

export function mergeSkillLists(primary: SkillListItem[], fallback: SkillListItem[]): SkillListItem[] {
  const merged = new Map<string, SkillListItem>();
  for (const skill of primary) {
    merged.set(skill.name, { ...skill, source: skill.source ?? 'mcp' });
  }
  for (const skill of fallback) {
    if (!merged.has(skill.name)) merged.set(skill.name, skill);
  }
  return Array.from(merged.values()).sort(sortSkills);
}

export function sortSkills(a: SkillListItem, b: SkillListItem): number {
  return (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name);
}

export function skillSearchRoots(
  workspaceRoot: string,
  opts: { includeBundled?: boolean } = {},
): string[] {
  const includeBundled = opts.includeBundled !== false;
  const roots: string[] = [];
  for (const sub of WORKSPACE_SKILL_ROOTS) roots.push(path.join(workspaceRoot, sub));

  // BUNDLED skill roots ship with the install (MCP package dir + the monorepo's
  // top-level `skills/`). CC-CONFIG-A6 lets a user hide these, keeping only the
  // workspace-authored roots above.
  if (includeBundled) {
    const mcpPkgDir = resolveInstalledMcpPackageDir();
    if (mcpPkgDir) {
      roots.push(path.join(mcpPkgDir, 'skills'));
      const monorepoRoot = path.dirname(mcpPkgDir);
      roots.push(path.join(monorepoRoot, 'skills'));
    }
  }

  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function resolveInstalledMcpPackageDir(): string | undefined {
  try {
    const pkgJsonPath = requireFromHere.resolve('@kinqs/brainrouter-mcp-server/package.json');
    return path.dirname(pkgJsonPath);
  } catch {
    return undefined;
  }
}

/**
 * CC-SKILLS-D2 — label a skill root by BrainRouter scope so collisions can be
 * displayed as `<scope>:<name>`. Precedence high→low mirrors the search order:
 *   workspace  — `<ws>/skills`            (author's top-level skills)
 *   local      — `<ws>/.brainrouter/skills` (workspace-private overrides)
 *   bundled    — everything shipped with the install (MCP pkg + monorepo root)
 */
function inferRootScope(root: string, workspaceRoot: string): string {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.join(resolvedWorkspace, '.brainrouter', 'skills')) return 'local';
  if (resolvedRoot.startsWith(path.join(resolvedWorkspace, '.brainrouter'))) return 'local';
  if (resolvedRoot === path.join(resolvedWorkspace, 'skills')) return 'workspace';
  // Any other root (installed MCP package `skills/`, monorepo root `skills/`)
  // is a bundled/shipped root, whether or not it happens to sit above the ws.
  return 'bundled';
}

function findSkillFiles(root: string): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number): void {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth - 1);
      else if (entry.isFile() && entry.name === 'SKILL.md') results.push(full);
    }
  }
  walk(root, 5);
  return results;
}

function parseSkillFile(filePath: string): { name: string; description?: string } | undefined {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }

  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatter?.[1] ?? '';
  const name = readYamlScalar(block, 'name') ?? path.basename(path.dirname(filePath));
  const description = readYamlScalar(block, 'description') ?? firstParagraph(raw);
  if (!name) return undefined;
  return { name, description };
}

function readYamlScalar(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match?.[1]) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

/** Extract the raw YAML frontmatter block (between the `---` fences), or ''. */
export function extractFrontmatterBlock(raw: string): string {
  return raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
}

/**
 * CC-SKILLS-D3 — parse a `disallowed-tools` list from SKILL.md frontmatter.
 * Accepts both the flow form (`disallowed-tools: [run_command, write_file]`)
 * and the block form:
 *   disallowed-tools:
 *     - run_command
 *     - write_file
 * Also tolerates comma/space-separated inline values. Returns a de-duped,
 * trimmed list (empty when the key is absent). Pure — no filesystem access.
 */
export function parseDisallowedToolsFrontmatter(raw: string): string[] {
  const block = extractFrontmatterBlock(raw);
  if (!block) return [];
  const lines = block.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^disallowed-tools\s*:/.test(l));
  if (idx < 0) return [];
  const header = lines[idx];
  const inline = header.replace(/^disallowed-tools\s*:/, '').trim();
  const out: string[] = [];
  const pushTokens = (s: string) => {
    for (const tok of s.replace(/^\[|\]$/g, '').split(/[,\s]+/)) {
      const t = tok.trim().replace(/^['"]|['"]$/g, '');
      if (t) out.push(t);
    }
  };
  if (inline) {
    pushTokens(inline);
  } else {
    // Block form: consume subsequent `  - value` lines until the indentation
    // drops back to a new top-level key.
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*-\s+/.test(line)) {
        pushTokens(line.replace(/^\s*-\s+/, ''));
      } else if (line.trim() === '') {
        continue;
      } else {
        break; // next top-level key
      }
    }
  }
  return [...new Set(out)];
}

function firstParagraph(raw: string): string | undefined {
  const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  const line = withoutFrontmatter
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#'));
  return line;
}
