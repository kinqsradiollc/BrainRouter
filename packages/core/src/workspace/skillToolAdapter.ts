/**
 * Per-workspace adapters for the BrainRouter MCP skill tools.
 *
 * The backend registry is intentionally process-global. Workspace manifests,
 * however, are task scoped and can differ between concurrent Agent instances.
 * This module therefore filters catalog payloads and serves package-owned
 * profile skills at the Agent/client boundary without mutating that registry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadWorkspaceManifest } from './manifest.js';
import {
  inspectWorkspaceProfilePlugins,
  type AvailableWorkspaceProfilePlugin,
} from './profilePlugins.js';
import { resolveWorkspaceSkillSelection } from './skillSelection.js';

export type WorkspaceSkillSection =
  | 'description'
  | 'overview'
  | 'when_to_use'
  | 'workflow'
  | 'usage'
  | 'detailed_instructions'
  | 'phases'
  | 'checklist'
  | 'red_flags'
  | 'rationalizations'
  | 'full';

export interface WorkspaceSkillCatalogEntry {
  name: string;
  description?: string;
  category?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface WorkspaceManagedSkillResult {
  content: Array<{ type: 'text'; text: string }>;
  metadata: {
    scope: 'plugin' | 'bundled';
    tokenEstimate: number;
    allowedTools?: string[];
    disallowedTools: string[];
  };
}

export interface WorkspaceSkillToolPolicyMetadata {
  allowedTools?: string[];
  disallowedTools: string[];
}

interface WorkspaceSkillToolPolicy {
  managed: boolean;
  ambientSkillIds: string[];
  disabledSkillIds: Set<string>;
  managedSkillIds: Set<string>;
  packageSkills: Map<string, PackageSkill>;
}

interface PackageSkill extends WorkspaceSkillCatalogEntry {
  filePath: string;
}

const BUNDLED_SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));
const STABLE_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SECTION_HEADINGS: Record<Exclude<WorkspaceSkillSection, 'description' | 'full' | 'phases' | 'checklist'>, string[]> = {
  overview: ['overview'],
  when_to_use: ['when to use', 'when to invoke', 'triggers'],
  workflow: ['workflow', 'core process', 'the workflow', 'steps', 'process', 'checklist', 'methodology', 'routine', 'guidelines', 'patterns', 'template', 'structure', 'lifecycle'],
  usage: ['usage', 'example usage', 'examples'],
  detailed_instructions: ['detailed instructions', 'instructions', 'detailed guide'],
  red_flags: ['red flags', 'warning signs'],
  rationalizations: ['common rationalizations', 'rationalizations'],
};

/**
 * Resolve a package-owned skill for an explicit `get_skill`/`/skill` request.
 * Disabled and currently inactive package skills remain explicitly readable;
 * executing them still passes through the normal skill tool-policy gates.
 */
export function resolveWorkspaceManagedSkill(
  workspaceRoot: string,
  name: string,
  section: unknown = 'workflow',
): WorkspaceManagedSkillResult | undefined {
  if (!isWorkspaceSkillSection(section)) return undefined;
  const policy = resolvePolicy(workspaceRoot, []);
  if (!policy.managed) return undefined;
  const skill = policy.packageSkills.get(name);
  if (!skill) return undefined;
  if (workspaceDefinesSkill(workspaceRoot, name)) return undefined;

  try {
    const raw = fs.readFileSync(skill.filePath, 'utf8');
    const { data } = splitFrontmatter(raw);
    const text = loadSection(raw, section);
    const allowedTools = frontmatterStringList(data['allowed-tools']);
    const disallowedTools = frontmatterStringList(data['disallowed-tools']) ?? [];
    return {
      content: [{ type: 'text', text }],
      metadata: {
        scope: 'plugin',
        tokenEstimate: Math.ceil(text.length / 4),
        ...(allowedTools ? { allowedTools } : {}),
        disallowedTools,
      },
    };
  } catch {
    // Package inspection is fail-safe and the file can still disappear between
    // validation and this read. Let the ordinary MCP/fallback path handle it.
    return undefined;
  }
}

/**
 * Resolve a package-bundled workflow when the skill service is unavailable.
 * Workspace-authored same-name definitions retain normal precedence and must
 * be served by the workspace-aware skill registry instead.
 */
export function resolveBundledWorkspaceSkill(
  workspaceRoot: string,
  name: string,
  section: unknown = 'workflow',
): WorkspaceManagedSkillResult | undefined {
  if (!isWorkspaceSkillSection(section) || !STABLE_SKILL_ID.test(name)) return undefined;
  if (workspaceDefinesSkill(workspaceRoot, name)) return undefined;
  let realRoot: string;
  try {
    if (fs.lstatSync(BUNDLED_SKILLS_ROOT).isSymbolicLink()) return undefined;
    realRoot = fs.realpathSync(BUNDLED_SKILLS_ROOT);
  } catch {
    return undefined;
  }
  let categories: fs.Dirent[];
  try {
    categories = fs.readdirSync(realRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const category of categories.slice(0, 128)) {
    if (!category.isDirectory() || category.isSymbolicLink()) continue;
    const candidate = path.join(realRoot, category.name, name, 'SKILL.md');
    const result = readResolvedSkillFile(candidate, realRoot, section, 'bundled');
    if (result) return result;
  }
  return undefined;
}

/** Preserve workspace-authored precedence without following links or unbounded scans. */
function workspaceDefinesSkill(workspaceRoot: string, name: string): boolean {
  const roots = [path.join(workspaceRoot, 'skills'), path.join(workspaceRoot, '.brainrouter', 'skills')];
  for (const root of roots) {
    let realRoot: string;
    try {
      if (fs.lstatSync(root).isSymbolicLink()) continue;
      realRoot = fs.realpathSync(root);
      if (!fs.lstatSync(realRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const pending = [realRoot];
    let visitedDirectories = 0;
    let visitedEntries = 0;
    while (pending.length > 0 && visitedDirectories < 2_048 && visitedEntries < 4_096) {
      const current = pending.pop()!;
      visitedDirectories += 1;
      let directory: fs.Dir;
      try {
        directory = fs.opendirSync(current);
      } catch {
        continue;
      }
      try {
        let entry: fs.Dirent | null;
        while (visitedEntries < 4_096 && (entry = directory.readSync()) !== null) {
          visitedEntries += 1;
          if (entry.isSymbolicLink()) continue;
          const candidate = path.join(current, entry.name);
          if (entry.isDirectory()) {
            pending.push(candidate);
            continue;
          }
          if (!entry.isFile() || entry.name !== 'SKILL.md') continue;
          try {
            const stat = fs.statSync(candidate);
            if (stat.size > 256 * 1024) continue;
            const realCandidate = fs.realpathSync(candidate);
            const relative = path.relative(realRoot, realCandidate);
            if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
            const { data } = splitFrontmatter(fs.readFileSync(realCandidate, 'utf8'));
            if (data.name === name) return true;
          } catch {
            // Unreadable or malformed workspace skills do not block a valid
            // package fallback; the ordinary catalog reports them separately.
          }
        }
      } finally {
        directory.closeSync();
      }
    }
  }
  return false;
}

function isWorkspaceSkillSection(value: unknown): value is WorkspaceSkillSection {
  return typeof value === 'string' && [
    'description',
    'overview',
    'when_to_use',
    'workflow',
    'usage',
    'detailed_instructions',
    'phases',
    'checklist',
    'red_flags',
    'rationalizations',
    'full',
  ].includes(value);
}

/** Apply task-scoped visibility to a `list_skills` or `search_skills` JSON payload. */
export function adaptWorkspaceSkillCatalogText(input: {
  workspaceRoot: string;
  activeCapabilities?: readonly string[];
  text: string;
  tool: 'list_skills' | 'search_skills';
  args?: Record<string, unknown>;
}): string {
  const policy = resolvePolicy(input.workspaceRoot, input.activeCapabilities ?? []);
  if (!policy.managed) return input.text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return input.text;
  }
  if (!Array.isArray(parsed) || !parsed.every(isCatalogEntry)) return input.text;

  const scope = typeof input.args?.scope === 'string' ? input.args.scope : 'all';
  const category = typeof input.args?.category === 'string' ? input.args.category : undefined;
  const query = input.tool === 'search_skills' && typeof input.args?.query === 'string'
    ? input.args.query.trim().toLowerCase()
    : '';
  const existing = new Map<string, WorkspaceSkillCatalogEntry>();

  for (const entry of parsed) {
    if (policy.disabledSkillIds.has(entry.name)) continue;
    if (policy.managedSkillIds.has(entry.name) && !policy.ambientSkillIds.includes(entry.name)) continue;
    if (!matchesScope(entry, scope) || (category && entry.category !== category)) continue;
    if (query && !matchesQuery(entry, query)) continue;
    existing.set(entry.name, entry);
  }

  const ordered: WorkspaceSkillCatalogEntry[] = [];
  const emitted = new Set<string>();
  for (const id of policy.ambientSkillIds) {
    if (policy.disabledSkillIds.has(id)) continue;
    const current = existing.get(id);
    const packaged = policy.packageSkills.get(id);
    // A workspace-local same-name skill keeps normal local-over-package
    // precedence. Global bundled collisions are replaced by the selected,
    // package-owned definition.
    const candidate = current?.scope === 'local' ? current : packaged ?? current;
    if (!candidate || !matchesScope(candidate, scope)) continue;
    if (category && candidate.category !== category) continue;
    if (query && !matchesQuery(candidate, query)) continue;
    ordered.push(input.tool === 'search_skills' ? withRelevance(candidate, query) : candidate);
    emitted.add(id);
  }

  const remainder = [...existing.values()]
    .filter((entry) => !emitted.has(entry.name))
    .sort(sortCatalogEntries);
  ordered.push(...remainder);
  return JSON.stringify(ordered, null, 2);
}

function resolvePolicy(
  workspaceRoot: string,
  activeCapabilities: readonly string[],
): WorkspaceSkillToolPolicy {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  if (!manifest) return emptyPolicy();

  const catalog = inspectWorkspaceProfilePlugins();
  const selection = resolveWorkspaceSkillSelection({ manifest, activeCapabilities, catalog });
  const packageSkills = new Map<string, PackageSkill>();
  for (const plugin of catalog.available) {
    for (const id of plugin.skillIds) {
      const skill = readPackageSkill(plugin, id);
      if (skill) packageSkills.set(id, skill);
    }
  }
  return {
    managed: selection.managed,
    ambientSkillIds: selection.ambientSkillIds,
    disabledSkillIds: new Set(selection.disabledSkillIds),
    managedSkillIds: new Set(
      [...catalog.available, ...catalog.unavailable].flatMap((plugin) => [...plugin.skillIds]),
    ),
    packageSkills,
  };
}

function readPackageSkill(plugin: AvailableWorkspaceProfilePlugin, id: string): PackageSkill | undefined {
  const filePath = path.join(plugin.skillsRoot, id, 'SKILL.md');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { data } = splitFrontmatter(raw);
    if (String(data.name ?? '') !== id) return undefined;
    return {
      name: id,
      description: typeof data.description === 'string' ? data.description : undefined,
      category: plugin.id,
      scope: 'plugin',
      filePath,
    };
  } catch {
    return undefined;
  }
}

function readResolvedSkillFile(
  filePath: string,
  containmentRoot: string,
  section: WorkspaceSkillSection,
  scope: WorkspaceManagedSkillResult['metadata']['scope'],
): WorkspaceManagedSkillResult | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 256 * 1024) return undefined;
    const realFile = fs.realpathSync(filePath);
    const relative = path.relative(fs.realpathSync(containmentRoot), realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(descriptor, bytes, read, bytes.length - read, null);
      if (count === 0) break;
      read += count;
    }
    const raw = bytes.subarray(0, read).toString('utf8');
    const { data } = splitFrontmatter(raw);
    const text = loadSection(raw, section);
    const allowedTools = frontmatterStringList(data['allowed-tools']);
    return {
      content: [{ type: 'text', text }],
      metadata: {
        scope,
        tokenEstimate: Math.ceil(text.length / 4),
        ...(allowedTools ? { allowedTools } : {}),
        disallowedTools: frontmatterStringList(data['disallowed-tools']) ?? [],
      },
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw.trim() };
  const value = parseYaml(match[1]);
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return { data, body: (match[2] ?? '').trim() };
}

function frontmatterStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse bounded skill tool-policy metadata for runtime stage activation. */
export function parseWorkspaceSkillToolPolicy(raw: string): WorkspaceSkillToolPolicyMetadata {
  const { data } = splitFrontmatter(raw);
  const allowedTools = frontmatterStringList(data['allowed-tools']);
  return {
    ...(allowedTools ? { allowedTools } : {}),
    disallowedTools: frontmatterStringList(data['disallowed-tools']) ?? [],
  };
}

function loadSection(raw: string, section: WorkspaceSkillSection): string {
  const { data, body } = splitFrontmatter(raw);
  if (section === 'full') return raw.trim();
  if (section === 'description') return typeof data.description === 'string' ? data.description : '';
  if (section === 'phases') {
    const lines: string[] = [];
    let active = false;
    for (const line of body.split('\n')) {
      if (/^###\s+phase/i.test(line)) active = true;
      else if (/^##\s/.test(line)) active = false;
      if (active) lines.push(line);
    }
    return lines.join('\n').trim() || '<!-- No phase blocks found -->';
  }
  if (section === 'checklist') {
    const checklist = body.split('\n').filter((line) => /^- \[[ x]\]/.test(line)).join('\n').trim();
    return checklist || '<!-- No checklist items found -->';
  }

  const sections = splitSections(body);
  const aliases = SECTION_HEADINGS[section];
  let match = sections.find((candidate) =>
    aliases.some((alias) => candidate.heading.toLowerCase().includes(alias)));
  if (!match && section === 'overview') {
    const preamble = sections.find((candidate) => candidate.heading === '__preamble__');
    if (preamble && preamble.content.length > 20) match = { heading: 'Overview', content: preamble.content };
  }
  return match
    ? `## ${match.heading}\n\n${match.content}`.trim()
    : `<!-- Section "${section}" not found -->`;
}

function splitSections(body: string): Array<{ heading: string; content: string }> {
  const sections: Array<{ heading: string; content: string }> = [];
  let heading = '__preamble__';
  let lines: string[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      sections.push({ heading, content: lines.join('\n').trim() });
      heading = match[1].trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  sections.push({ heading, content: lines.join('\n').trim() });
  return sections;
}

function matchesScope(entry: WorkspaceSkillCatalogEntry, scope: string): boolean {
  if (scope === 'all') return true;
  if (entry.scope === 'plugin') return scope === 'global';
  return entry.scope === scope;
}

function matchesQuery(entry: WorkspaceSkillCatalogEntry, query: string): boolean {
  return entry.name.toLowerCase().includes(query)
    || String(entry.description ?? '').toLowerCase().includes(query)
    || String(entry.category ?? '').toLowerCase().includes(query);
}

function withRelevance(entry: WorkspaceSkillCatalogEntry, query: string): WorkspaceSkillCatalogEntry {
  if ('relevance' in entry) return entry;
  return {
    ...entry,
    relevance: entry.name.toLowerCase().includes(query)
      ? 'name match'
      : String(entry.description ?? '').toLowerCase().includes(query)
        ? 'description match'
        : 'category match',
  };
}

function isCatalogEntry(value: unknown): value is WorkspaceSkillCatalogEntry {
  return Boolean(value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string');
}

function sortCatalogEntries(a: WorkspaceSkillCatalogEntry, b: WorkspaceSkillCatalogEntry): number {
  return String(a.category ?? '').localeCompare(String(b.category ?? '')) || a.name.localeCompare(b.name);
}

function emptyPolicy(): WorkspaceSkillToolPolicy {
  return {
    managed: false,
    ambientSkillIds: [],
    disabledSkillIds: new Set(),
    managedSkillIds: new Set(),
    packageSkills: new Map(),
  };
}
