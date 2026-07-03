/**
 * PLUGIN-MARKETPLACE P1 — the plugin MANIFEST schema + parser/validator.
 *
 * A plugin is a folder (or git repo) whose `.brainrouter-plugin/plugin.json`
 * describes what it contributes to the existing subsystems (skills / agents /
 * commands / hooks / workflows / connectors / MCP servers). Only `name` is
 * required; the convention dirs are auto-discovered so a skills-only plugin is
 * just `plugin.json` + `skills/`.
 *
 * BrainRouter's own conventions: the manifest lives under
 * `.brainrouter-plugin/plugin.json` (never `.claude`). Portable references
 * inside hooks / mcp / connector assets use `${BRAINROUTER_PLUGIN_ROOT}`.
 *
 * This module is PURE parsing/validation — no filesystem reads. See
 * `manifestFs.ts` for the disk-backed discovery/loading.
 */

/** Manifest dir + file names — BrainRouter conventions (never `.claude`). */
export const PLUGIN_MANIFEST_DIR = '.brainrouter-plugin';
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
/** Portable-path token expanded to the plugin's absolute root at load time. */
export const PLUGIN_ROOT_TOKEN = '${BRAINROUTER_PLUGIN_ROOT}';

/** Convention component dirs / files auto-discovered when `contributes` omits them. */
export const PLUGIN_CONVENTION_PATHS = {
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
  hooks: 'hooks/hooks.json',
  workflows: 'workflows',
  connectors: 'connectors',
  mcpServers: 'mcp.json',
} as const;

export type PluginComponentKind = keyof typeof PLUGIN_CONVENTION_PATHS;

export const PLUGIN_CATEGORIES = [
  'development',
  'productivity',
  'research',
  'design',
  'security',
  'data',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface PluginCompatibility {
  brainrouterVersion?: string;
  agentApiVersion?: string;
}

/** Optional custom component paths (supplement the auto-discovered dirs). */
export interface PluginContributes {
  skills?: string;
  agents?: string;
  commands?: string;
  hooks?: string;
  workflows?: string;
  connectors?: string;
  mcpServers?: string;
}

export interface PluginManifest {
  /** REQUIRED, kebab-case, unique. */
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  category?: PluginCategory;
  keywords?: string[];
  compatibility?: PluginCompatibility;
  contributes?: PluginContributes;
}

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors: string[];
  warnings: string[];
}

/** kebab-case: lowercase letters/digits, single hyphens between, no leading/trailing hyphen. */
export const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseAuthor(v: unknown): PluginAuthor | undefined {
  if (typeof v === 'string') return { name: v.trim() || undefined };
  if (!isPlainObject(v)) return undefined;
  const out: PluginAuthor = {};
  if (typeof v.name === 'string' && v.name.trim()) out.name = v.name.trim();
  if (typeof v.email === 'string' && v.email.trim()) out.email = v.email.trim();
  if (typeof v.url === 'string' && v.url.trim()) out.url = v.url.trim();
  return Object.keys(out).length ? out : undefined;
}

function parseContributes(v: unknown, errors: string[]): PluginContributes | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) {
    errors.push('contributes must be an object mapping component kinds to relative paths');
    return undefined;
  }
  const out: PluginContributes = {};
  for (const kind of Object.keys(PLUGIN_CONVENTION_PATHS) as PluginComponentKind[]) {
    const raw = v[kind];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`contributes.${kind} must be a non-empty relative path string`);
      continue;
    }
    const rel = raw.trim();
    // Reject absolute / parent-escaping paths — a manifest must stay inside its own tree.
    if (rel.startsWith('/') || rel.startsWith('\\') || rel.split(/[\\/]+/).includes('..')) {
      errors.push(`contributes.${kind} must be a relative path inside the plugin (got "${rel}")`);
      continue;
    }
    out[kind] = rel;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Parse + validate a raw plugin manifest object (already JSON-parsed).
 * Returns the sanitized manifest plus errors/warnings. `name` is the only
 * hard requirement; a bad `category` / `version` is a WARNING (installer
 * warns, never hard-fails silently — plan §3.2).
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['manifest must be a JSON object'], warnings };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    errors.push('manifest.name is required');
  } else if (!KEBAB_CASE_RE.test(name)) {
    errors.push(`manifest.name must be kebab-case (got "${name}")`);
  }

  const manifest: PluginManifest = { name };

  if (raw.version !== undefined) {
    if (typeof raw.version === 'string' && raw.version.trim()) manifest.version = raw.version.trim();
    else warnings.push('manifest.version should be a non-empty semver string');
  }
  if (typeof raw.description === 'string') manifest.description = raw.description.trim();
  if (typeof raw.homepage === 'string' && raw.homepage.trim()) manifest.homepage = raw.homepage.trim();
  if (typeof raw.repository === 'string' && raw.repository.trim()) manifest.repository = raw.repository.trim();
  if (typeof raw.license === 'string' && raw.license.trim()) manifest.license = raw.license.trim();

  const author = parseAuthor(raw.author);
  if (author) manifest.author = author;

  if (raw.category !== undefined) {
    if (typeof raw.category === 'string' && (PLUGIN_CATEGORIES as readonly string[]).includes(raw.category)) {
      manifest.category = raw.category as PluginCategory;
    } else {
      warnings.push(`manifest.category "${String(raw.category)}" is not one of ${PLUGIN_CATEGORIES.join('|')}`);
    }
  }

  const keywords = sanitizeStringArray(raw.keywords);
  if (keywords.length) manifest.keywords = keywords;

  if (raw.compatibility !== undefined) {
    if (isPlainObject(raw.compatibility)) {
      const compat: PluginCompatibility = {};
      if (typeof raw.compatibility.brainrouterVersion === 'string' && raw.compatibility.brainrouterVersion.trim()) {
        compat.brainrouterVersion = raw.compatibility.brainrouterVersion.trim();
      }
      if (typeof raw.compatibility.agentApiVersion === 'string' && raw.compatibility.agentApiVersion.trim()) {
        compat.agentApiVersion = raw.compatibility.agentApiVersion.trim();
      }
      if (Object.keys(compat).length) manifest.compatibility = compat;
    } else {
      warnings.push('manifest.compatibility must be an object');
    }
  }

  const contributes = parseContributes(raw.contributes, errors);
  if (contributes) manifest.contributes = contributes;

  return { valid: errors.length === 0, manifest: errors.length === 0 ? manifest : undefined, errors, warnings };
}

/**
 * Parse manifest JSON text → validation result. A JSON syntax error is a
 * hard error (never throws).
 */
export function parseManifest(text: string): ManifestValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${(err as Error).message}`], warnings: [] };
  }
  return validateManifest(raw);
}

/** Expand `${BRAINROUTER_PLUGIN_ROOT}` in a string to the plugin's absolute root. */
export function expandPluginRoot(value: string, pluginRoot: string): string {
  // Support both the token form and the bare `$BRAINROUTER_PLUGIN_ROOT`.
  return value
    .split(PLUGIN_ROOT_TOKEN).join(pluginRoot)
    .split('$BRAINROUTER_PLUGIN_ROOT').join(pluginRoot);
}
