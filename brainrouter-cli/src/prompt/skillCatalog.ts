import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { getOrgConventionRepoRoots, loadPluginsWithKnobs } from '@kinqs/brainrouter-core/plugin';
import {
  inspectWorkspaceProfilePlugins,
  loadWorkspaceManifest,
  resolveWorkspaceCapabilities,
  resolveWorkspaceSkillSelection,
  workspaceProfilePluginSkillIds,
} from '@kinqs/brainrouter-core/workspace';

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
  /**
   * ADR-027 D3 — the skill declared `disable-model-invocation`. It stays
   * explicitly invokable by a human but is kept out of the ambient catalog the
   * model sees, so its description never enters the turn window.
   */
  disableModelInvocation?: boolean;
}

const WORKSPACE_SKILL_ROOTS = ['skills', '.brainrouter/skills'];

export interface WorkspaceSkillCatalogContext {
  /** Current task text, used only for task-scoped capability activation. */
  task?: string;
  /** Files already known to be in scope for the current task. */
  files?: readonly string[];
  /** Active domain persona; defaults to the manifest's configured default. */
  activeAgent?: string;
}

export interface SkillSearchRootOptions extends WorkspaceSkillCatalogContext {
  includeBundled?: boolean;
  /** Explicit lookup keeps disabled package skills invokable. */
  visibility?: 'ambient' | 'explicit';
}

export interface WorkspaceSkillCatalogPolicy {
  /** False means callers must preserve the legacy catalog exactly. */
  managed: boolean;
  selectedSkillRoots: string[];
  explicitSkillRoots: string[];
  /** Standard profile/capability ids controlled by manifest selection. */
  managedSkillIds: string[];
  ambientSkillIds: string[];
  disabledSkillIds: string[];
}

export function resolveWorkspaceSkillCatalogPolicy(
  workspaceRoot: string,
  context: WorkspaceSkillCatalogContext = {},
): WorkspaceSkillCatalogPolicy {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  if (!manifest) {
    return {
      managed: false,
      selectedSkillRoots: [],
      explicitSkillRoots: [],
      managedSkillIds: [],
      ambientSkillIds: [],
      disabledSkillIds: [],
    };
  }

  const catalog = inspectWorkspaceProfilePlugins();
  const capabilities = resolveWorkspaceCapabilities({
    manifest,
    task: context.task,
    files: context.files,
    activeAgent: context.activeAgent,
  });
  const selection = resolveWorkspaceSkillSelection({
    manifest,
    activeCapabilities: capabilities.active,
    catalog,
  });
  return {
    managed: selection.managed,
    selectedSkillRoots: selection.skillRoots,
    explicitSkillRoots: catalog.available.map((plugin) => plugin.skillsRoot),
    managedSkillIds: [...catalog.available, ...catalog.unavailable]
      .flatMap(workspaceProfilePluginSkillIds),
    ambientSkillIds: selection.ambientSkillIds,
    disabledSkillIds: selection.disabledSkillIds,
  };
}

export function listFilesystemSkills(
  workspaceRoot: string,
  context: WorkspaceSkillCatalogContext = {},
): SkillListItem[] {
  const knobs = getCliKnobs();
  // CC-CONFIG-A1 — safe mode loads NO skills at all (isolate a bad skill).
  if (knobs.safeMode) return [];
  const policy = resolveWorkspaceSkillCatalogPolicy(workspaceRoot, context);
  // First entry per name WINS (roots are ordered workspace → local → bundled),
  // consistent with resolveSkill's precedence. CC-SKILLS-D2: we no longer drop
  // the shadowed copies silently — we record the collision so the /skills
  // listing can render `<scope>:<name>` and mark what's hidden.
  const winners = new Map<string, SkillListItem>();
  const shadowScopes = new Map<string, string[]>();
  // CC-CONFIG-A6 — optionally hide BUNDLED skills (shipped with the install),
  // leaving only workspace-authored skill roots (skills/, .brainrouter/skills).
  for (const root of buildSkillSearchRoots(workspaceRoot, {
    ...context,
    includeBundled: !knobs.skillsHideBundled,
  }, policy)) {
    if (!fs.existsSync(root)) continue;
    const scope = inferRootScope(root, workspaceRoot, policy.explicitSkillRoots);
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
          ...(parsed.disableModelInvocation ? { disableModelInvocation: true } : {}),
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
  return applyWorkspaceSkillCatalogPolicy(Array.from(winners.values()), policy);
}

/** Apply manifest ambient visibility to MCP or filesystem list results. */
export function applyWorkspaceSkillCatalogPolicy(
  skills: SkillListItem[],
  policy: WorkspaceSkillCatalogPolicy,
): SkillListItem[] {
  // ADR-027 D3 — a human-only skill is never ambient, regardless of manifest
  // state. It remains resolvable by explicit name.
  skills = skills.filter((skill) => !skill.disableModelInvocation);
  if (!policy.managed) return skills.sort(sortSkills);
  const disabled = new Set(policy.disabledSkillIds);
  const managed = new Set(policy.managedSkillIds);
  const ambient = new Set(policy.ambientSkillIds);
  const priority = new Map(policy.ambientSkillIds.map((id, index) => [id, index]));
  return skills
    .filter((skill) =>
      !disabled.has(skill.name) && (!managed.has(skill.name) || ambient.has(skill.name)))
    .sort((a, b) => {
      const aPriority = priority.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const bPriority = priority.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      return aPriority - bPriority || sortSkills(a, b);
    });
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
  opts: SkillSearchRootOptions = {},
): string[] {
  const policy = resolveWorkspaceSkillCatalogPolicy(workspaceRoot, opts);
  return buildSkillSearchRoots(workspaceRoot, opts, policy);
}

function buildSkillSearchRoots(
  workspaceRoot: string,
  opts: SkillSearchRootOptions,
  policy: WorkspaceSkillCatalogPolicy,
): string[] {
  const includeBundled = opts.includeBundled !== false;
  const roots: string[] = [];
  for (const sub of WORKSPACE_SKILL_ROOTS) roots.push(path.join(workspaceRoot, sub));

  if (policy.managed) {
    const selectedRoots = opts.visibility === 'explicit'
      ? policy.explicitSkillRoots
      : policy.selectedSkillRoots;
    roots.push(...selectedRoots);
  }

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
    // The CLI package's OWN copy of the skill library (generated from the
    // monorepo root at build/pack time — see scripts/bundle-content.mjs).
    // Lowest bundled precedence: in a monorepo/mcp install the identical names
    // above win via first-root-wins dedupe, but a CLI-only or desktop install
    // still gets the whole library so /init and onboarding ship with their
    // workflow skills.
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
function inferRootScope(
  root: string,
  workspaceRoot: string,
  packageProfileRoots: readonly string[] = [],
): string {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedRoot = path.resolve(root);
  // PLUGIN-MARKETPLACE P1 — a skill root under a `.brainrouter/plugins/<name>/`
  // tree (user OR workspace scope) is a PLUGIN root, not a plain local override.
  if (isOrgConventionRoot(resolvedRoot)) return 'org';
  if (packageProfileRoots.some((profileRoot) => path.resolve(profileRoot) === resolvedRoot)) return 'plugin';
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

function parseSkillFile(filePath: string): { name: string; description?: string; triggers: string[]; disableModelInvocation?: boolean } | undefined {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }

  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatter?.[1] ?? '';
  const name = readYamlScalar(block, 'name') ?? path.basename(path.dirname(filePath));
  const description = readYamlScalar(block, 'description') ?? firstParagraph(raw);
  if (!name) return undefined;
  // ADR-027 D3 — honor `disable-model-invocation`: a human-only skill must not be
  // model-invocable, and its description must stay out of the model's catalog.
  // The brain parses frontmatter with a real YAML parser, so it accepts every
  // YAML-truthy spelling; this regex reader must agree or the same file would be
  // human-only on one surface and model-invocable on the other.
  const humanOnly = isYamlTrue(readYamlScalar(block, 'disable-model-invocation'));
  return {
    name,
    description,
    triggers: parseSkillTriggersFrontmatter(raw),
    ...(humanOnly ? { disableModelInvocation: true } : {}),
  };
}

/** YAML-truthy scalars, matching what a real YAML parser accepts. */
function isYamlTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['true', 'yes', 'on', 'y'].includes(value.trim().toLowerCase());
}

function readYamlScalar(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  // Read the scalar the way a real YAML parser does, because the brain uses one
  // and the two surfaces must agree. A QUOTED scalar keeps its contents verbatim
  // (a `#` inside quotes is data, not a comment); an UNQUOTED scalar ends at the
  // first whitespace-preceded `#`. Without the comment rule,
  // `disable-model-invocation: true # note` reads as human-only on the brain and
  // model-invocable here, leaking the description into the model's catalog.
  const quoted = raw.match(/^(['"])([\s\S]*?)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2];
  return raw.replace(/\s+#.*$/, '').trim();
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
  return parseToolListFrontmatter(raw, 'disallowed-tools') ?? [];
}

/**
 * Parse an optional `allowed-tools` turn allowlist from SKILL.md.
 * `undefined` means the skill declares no additional restriction; a declared
 * empty list means the skill intentionally exposes no tools. Forms match
 * `disallowed-tools` so the dependency-free frontmatter contract stays small.
 */
export function parseAllowedToolsFrontmatter(raw: string): string[] | undefined {
  return parseToolListFrontmatter(raw, 'allowed-tools');
}

function parseToolListFrontmatter(raw: string, key: 'allowed-tools' | 'disallowed-tools'): string[] | undefined {
  const block = extractFrontmatterBlock(raw);
  if (!block) return undefined;
  const lines = block.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}\\s*:`);
  const idx = lines.findIndex((line) => keyPattern.test(line));
  if (idx < 0) return undefined;
  const inline = lines[idx].replace(keyPattern, '').trim();
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
