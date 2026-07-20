import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { getOrgConventionRepoRoots, loadPluginsWithKnobs } from '@kinqs/brainrouter-core/plugin';

const requireFromHere = createRequire(import.meta.url);

export interface SkillListItem {
  name: string;
  scope?: string;
  category?: string;
  description?: string;
  source?: 'mcp' | 'filesystem';
  /** MC-E4 — org-administered skill rows are visible but not editable locally. */
  readOnly?: boolean;
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
  /**
   * MC-E2 — hard keyword triggers declared in the SKILL.md frontmatter
   * (`triggers: [word, ...]` and/or `keywords: [...]`). A DORMANT skill whose
   * trigger word appears in a plain user prompt (case-insensitive,
   * word-boundary) is injected into the turn like an explicit /skill
   * invocation. Absent/empty when the skill declares no triggers.
   */
  triggers?: string[];
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
        const readOnly = scope === 'org';
        winners.set(parsed.name, {
          name: parsed.name,
          category,
          description: parsed.description,
          scope,
          source: 'filesystem',
          ...(readOnly ? { readOnly } : {}),
          qualifiedName: `${scope}:${parsed.name}`,
          // MC-E2 — surface declared keyword triggers so the dispatch path
          // can arm dormant skills without re-reading every SKILL.md.
          ...(parsed.triggers.length ? { triggers: parsed.triggers } : {}),
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

  // PLUGIN-MARKETPLACE P1 — enabled plugins contribute skill dirs here, between
  // the workspace roots (which still win) and the bundled install roots. A
  // plugin is a thin packaging wrapper feeding the SAME skill catalog. Skipped
  // under safeMode (loadPlugins returns no roots then). Best-effort: config/FS
  // trouble must never break skill discovery.
  try {
    for (const root of loadPluginsWithKnobs(workspaceRoot, getCliKnobs()).contributions.skillRoots) {
      roots.push(root);
    }
  } catch { /* plugin loading is additive — never fatal to skills */ }

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
    // The CLI package's OWN starter skills (synced copies of the monorepo set —
    // see scripts/sync-bundled-skills.mjs). Lowest bundled precedence: in a
    // monorepo/mcp install the identical names above win via first-root-wins
    // dedupe, but a CLI-only or desktop install still gets the starter set so
    // /init and onboarding ship with their workflow skills.
    roots.push(OWN_BUNDLED_SKILLS_DIR);
  }

  return [...new Set(roots.map((root) => path.resolve(root)))];
}

// dist/prompt/skillCatalog.js → ../../skills = the CLI package's skills/ dir
// (same own-package pattern as BUILTIN_PACKS_DIR in core's pack/packs.ts).
const OWN_BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url));

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
  // PLUGIN-MARKETPLACE P1 — a skill root under a `.brainrouter/plugins/<name>/`
  // tree (user OR workspace scope) is a PLUGIN root, not a plain local override.
  if (isOrgConventionRoot(resolvedRoot)) return 'org';
  if (resolvedRoot.includes(`${path.sep}.brainrouter${path.sep}plugins${path.sep}`)) return 'plugin';
  if (resolvedRoot === path.join(resolvedWorkspace, '.brainrouter', 'skills')) return 'local';
  if (resolvedRoot.startsWith(path.join(resolvedWorkspace, '.brainrouter'))) return 'local';
  if (resolvedRoot === path.join(resolvedWorkspace, 'skills')) return 'workspace';
  // Any other root (installed MCP package `skills/`, monorepo root `skills/`)
  // is a bundled/shipped root, whether or not it happens to sit above the ws.
  return 'bundled';
}

function isOrgConventionRoot(resolvedRoot: string): boolean {
  for (const repoRoot of getOrgConventionRepoRoots()) {
    const resolvedRepo = path.resolve(repoRoot);
    if (resolvedRoot === path.join(resolvedRepo, 'skills')) return true;
    if (resolvedRoot.startsWith(`${resolvedRepo}${path.sep}plugins${path.sep}`)) return true;
  }
  return false;
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

function parseSkillFile(filePath: string): { name: string; description?: string; triggers: string[] } | undefined {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }

  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatter?.[1] ?? '';
  const name = readYamlScalar(block, 'name') ?? path.basename(path.dirname(filePath));
  const description = readYamlScalar(block, 'description') ?? firstParagraph(raw);
  if (!name) return undefined;
  return { name, description, triggers: parseSkillTriggersFrontmatter(raw) };
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

/**
 * MC-E2 — parse the keyword-trigger list from SKILL.md frontmatter. Both
 * `triggers:` and `keywords:` are accepted (and merged) so authors can use
 * either name. Accepts the flow form (`triggers: [deploy, rollback]`) and the
 * block form:
 *   triggers:
 *     - deploy
 *     - rollback
 * Items are comma-separated (NOT whitespace-split) so multi-word phrases like
 * `hot fix` survive as one trigger. Returns a trimmed list de-duped
 * case-insensitively (first spelling wins); empty when neither key is present.
 * Pure — no filesystem access.
 */
export function parseSkillTriggersFrontmatter(raw: string): string[] {
  const block = extractFrontmatterBlock(raw);
  if (!block) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of ['triggers', 'keywords']) {
    for (const value of readYamlList(block, key)) {
      const dedupeKey = value.toLowerCase();
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        out.push(value);
      }
    }
  }
  return out;
}

/**
 * MC-E2 — read a YAML list value (flow `key: [a, b]` or block `- item` form)
 * from a frontmatter block. Comma-separated only, so items may contain spaces.
 */
function readYamlList(block: string, key: string): string[] {
  const lines = block.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (idx < 0) return [];
  const inline = lines[idx].replace(new RegExp(`^${key}\\s*:`), '').trim();
  const out: string[] = [];
  const pushItems = (s: string) => {
    for (const item of s.replace(/^\[|\]$/g, '').split(',')) {
      const t = item.trim().replace(/^['"]|['"]$/g, '').trim();
      if (t) out.push(t);
    }
  };
  if (inline) {
    pushItems(inline);
  } else {
    // Block form: consume `  - value` lines until the next top-level key.
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*-\s+/.test(line)) {
        pushItems(line.replace(/^\s*-\s+/, ''));
      } else if (line.trim() === '') {
        continue;
      } else {
        break; // next top-level key
      }
    }
  }
  return out;
}

function firstParagraph(raw: string): string | undefined {
  const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  const line = withoutFrontmatter
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#'));
  return line;
}
