/**
 * Workspace domain-persona catalog.
 *
 * Domain personas are prompt overlays for the active project identity. They are
 * deliberately separate from orchestration harness roles such as `worker` and
 * `reviewer`, which continue to control child execution posture. Resolution is
 * first-match-wins across workspace, local, enabled-plugin, and bundled files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCliKnobs } from '../config/config.js';
import { loadPluginsWithKnobs } from '../plugin/loader.js';
import { parseFrontmatterConfig, splitFrontmatter } from '../plugin/localConfig.js';
import { RESERVED_ORCHESTRATION_ROLE_IDS } from './personaDefinitionFile.js';
import { containsWorkspaceSecretMaterial } from './workspaceContentSafety.js';

export type DomainPersonaSource = 'workspace' | 'local' | 'plugin' | 'bundled';

export interface DomainPersonaDefinition {
  id: string;
  displayName: string;
  description: string;
  prompt: string;
  source: DomainPersonaSource;
  filePath: string;
  qualifiedName: string;
  collides?: boolean;
  shadowedBy?: string[];
}

export interface DomainPersonaCatalogOptions {
  /** Explicit plugin files for deterministic hosts/tests; omitted loads enabled plugins. */
  pluginAgentFiles?: ReadonlyArray<{ pluginName: string; path: string; pluginRoot?: string }>;
  /** Override only for package-layout tests. */
  bundledDir?: string;
}

interface PersonaCandidate {
  source: DomainPersonaSource;
  scope: string;
  filePath: string;
  boundaryRoot?: string;
}

const MAX_PERSONA_FILE_BYTES = 32 * 1024;
const MAX_PERSONA_PROMPT_CHARS = 16 * 1024;
const MAX_PERSONA_DESCRIPTION_CHARS = 512;
const PERSONA_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// dist/workspace/domainPersonas.js -> ../../agents = package-owned definitions.
const BUNDLED_PERSONAS_DIR = fileURLToPath(new URL('../../agents', import.meta.url));

/** Harness roles are never valid domain identities, even when a manifest names one. */
export const RESERVED_HARNESS_ROLE_IDS = RESERVED_ORCHESTRATION_ROLE_IDS;

/** Load the effective domain-persona catalog in stable precedence order. */
export function listDomainPersonas(
  workspaceRoot: string,
  options: DomainPersonaCatalogOptions = {},
): DomainPersonaDefinition[] {
  const candidates: PersonaCandidate[] = [
    ...listMarkdownFiles(path.join(workspaceRoot, 'agents'), workspaceRoot).map((filePath) => ({
      source: 'workspace' as const,
      scope: 'workspace',
      filePath,
    })),
    ...listMarkdownFiles(path.join(workspaceRoot, '.brainrouter', 'agents'), workspaceRoot).map((filePath) => ({
      source: 'local' as const,
      scope: 'local',
      filePath,
    })),
    ...resolvePluginAgentFiles(workspaceRoot, options.pluginAgentFiles).map((entry) => ({
      source: 'plugin' as const,
      scope: `plugin:${entry.pluginName}`,
      filePath: entry.path,
      boundaryRoot: entry.pluginRoot,
    })),
    ...listMarkdownFiles(options.bundledDir ?? BUNDLED_PERSONAS_DIR).map((filePath) => ({
      source: 'bundled' as const,
      scope: 'bundled',
      filePath,
    })),
  ];

  const winners = new Map<string, DomainPersonaDefinition>();
  const shadowedScopes = new Map<string, string[]>();
  for (const candidate of candidates) {
    const parsed = parseDomainPersona(candidate);
    if (!parsed) continue;
    if (!winners.has(parsed.id)) {
      winners.set(parsed.id, parsed);
      continue;
    }
    const scopes = shadowedScopes.get(parsed.id) ?? [];
    if (!scopes.includes(candidate.scope)) scopes.push(candidate.scope);
    shadowedScopes.set(parsed.id, scopes);
  }

  for (const [id, scopes] of shadowedScopes) {
    const winner = winners.get(id);
    if (winner) {
      winner.collides = true;
      winner.shadowedBy = scopes;
    }
  }
  return [...winners.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Resolve one active domain identity. Unknown and harness-role ids fail closed. */
export function findDomainPersona(
  id: string,
  workspaceRoot: string,
  options: DomainPersonaCatalogOptions = {},
): DomainPersonaDefinition | undefined {
  const normalized = id.trim();
  if (!PERSONA_ID.test(normalized) || RESERVED_HARNESS_ROLE_IDS.has(normalized)) return undefined;
  return listDomainPersonas(workspaceRoot, options).find((persona) => persona.id === normalized);
}

/** Render the bounded developer-prompt block consumed by runtime prompt layering. */
export function renderDomainPersonaBriefing(persona: DomainPersonaDefinition): string {
  return [
    '## Workspace domain persona',
    `Active domain persona: ${persona.displayName} (${persona.id})`,
    persona.prompt,
  ].join('\n\n');
}

function resolvePluginAgentFiles(
  workspaceRoot: string,
  provided: DomainPersonaCatalogOptions['pluginAgentFiles'],
): Array<{ pluginName: string; path: string; pluginRoot?: string }> {
  if (provided) return [...provided].sort(comparePluginFiles);
  try {
    const plugins = loadPluginsWithKnobs(workspaceRoot, getCliKnobs());
    const roots = new Map(plugins.loaded.map((plugin) => [plugin.name, plugin.root]));
    return plugins.contributions.agentFiles.map((entry) => ({
      ...entry,
      pluginRoot: roots.get(entry.pluginName) ??
        (entry.pluginName.startsWith('org:') ? path.dirname(path.dirname(entry.path)) : undefined),
    })).sort(comparePluginFiles);
  } catch {
    return [];
  }
}

function comparePluginFiles(
  a: { pluginName: string; path: string },
  b: { pluginName: string; path: string },
): number {
  return a.pluginName.localeCompare(b.pluginName) || a.path.localeCompare(b.path);
}

function listMarkdownFiles(dir: string, boundaryRoot = dir): string[] {
  let entries: fs.Dirent[];
  try {
    const resolvedBoundary = path.resolve(boundaryRoot);
    const resolvedDir = path.resolve(dir);
    const relativeDir = path.relative(resolvedBoundary, resolvedDir);
    if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) return [];
    // Reject a symlinked `agents` directory or any symlinked descendant below
    // the accepted root. Prompt discovery must not escape through an ancestor
    // link even though the final file is opened with O_NOFOLLOW below.
    let current = resolvedBoundary;
    for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return [];
    }
    if (!fs.lstatSync(resolvedDir).isDirectory()) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function parseDomainPersona(candidate: PersonaCandidate): DomainPersonaDefinition | undefined {
  const raw = readBoundedRegularFile(candidate.filePath, candidate.boundaryRoot);
  if (!raw) return undefined;
  const { yaml, body } = splitFrontmatter(raw);
  if (!yaml || !body || body.length > MAX_PERSONA_PROMPT_CHARS) return undefined;
  if (UNSAFE_CONTROL_CHARACTERS.test(body) || containsWorkspaceSecretMaterial(body)) return undefined;

  const config = parseFrontmatterConfig(yaml);
  const id = typeof config.name === 'string' ? config.name.trim() : '';
  const description = typeof config.description === 'string' ? config.description.trim() : '';
  const expectedId = path.basename(candidate.filePath, '.md');
  if (!PERSONA_ID.test(id) || id !== expectedId || RESERVED_HARNESS_ROLE_IDS.has(id)) return undefined;
  if (!description || description.length > MAX_PERSONA_DESCRIPTION_CHARS) return undefined;
  if (UNSAFE_CONTROL_CHARACTERS.test(description) || containsWorkspaceSecretMaterial(description)) return undefined;

  return {
    id,
    displayName: titleCase(id),
    description,
    prompt: body,
    source: candidate.source,
    filePath: candidate.filePath,
    qualifiedName: `${candidate.scope}:${id}`,
  };
}

function readBoundedRegularFile(filePath: string, boundaryRoot?: string): string | undefined {
  let fd: number | undefined;
  try {
    if (boundaryRoot && !isBoundedPathWithoutSymlinks(filePath, boundaryRoot)) return undefined;
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PERSONA_FILE_BYTES) return undefined;
    const bytes = fs.readFileSync(fd);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isBoundedPathWithoutSymlinks(filePath: string, boundaryRoot: string): boolean {
  try {
    const resolvedBoundary = path.resolve(boundaryRoot);
    const resolvedFile = path.resolve(filePath);
    const relativeFile = path.relative(resolvedBoundary, resolvedFile);
    if (!relativeFile || relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) return false;
    let current = resolvedBoundary;
    for (const segment of relativeFile.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    const realBoundary = fs.realpathSync(resolvedBoundary);
    const realFile = fs.realpathSync(resolvedFile);
    const realRelative = path.relative(realBoundary, realFile);
    return !!realRelative && !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
  } catch {
    return false;
  }
}

function titleCase(id: string): string {
  return id.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}
