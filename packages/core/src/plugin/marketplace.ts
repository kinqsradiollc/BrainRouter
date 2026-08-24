/**
 * PLUGIN-MARKETPLACE P2 — marketplace SOURCES + install-by-name.
 *
 * A marketplace is a repo/dir/tarball whose root holds a
 * `brainrouter-marketplace.json` indexing one or many plugins. This module:
 *   - parses the marketplace manifest (name, owner, plugins[]),
 *   - records/removes/lists marketplace sources in `cli.plugins.marketplaces[]`,
 *   - fetches a marketplace's manifest (git clone / local read / — http later),
 *   - resolves `plugin install <name>` across every configured marketplace and
 *     stages+installs that plugin's source (reusing P1's atomic `installPlugin`,
 *     with git sub-path + pinned ref support).
 *
 * BrainRouter conventions only (`.brainrouter/`, `brainrouter-marketplace.json`).
 * Everything is additive + inert until a marketplace is added.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadOrInitConfig, resolveCliKnobs, saveConfig } from '../config/config.js';
import type { Config, MarketplaceSource } from '../config/configTypes.js';
import { stagingDir } from './paths.js';
import { installPlugin, classifySource, type InstallOptions, type InstallResult } from './install.js';
import { assertMarketplaceAllowed, assertPluginAllowed, type ManagedGates } from './trust.js';

/** Derive the managed gates from a Config's resolved-shape plugin knobs (fail-open). */
function gatesFromConfig(config: Config): ManagedGates {
  const p = config.cli?.plugins;
  return {
    allowedMarketplaces: p?.allowedMarketplaces ?? [],
    blockedMarketplaces: p?.blockedMarketplaces ?? [],
    allowedPlugins: p?.allowedPlugins ?? [],
    blockedPlugins: p?.blockedPlugins ?? [],
    allowManagedHooksOnly: p?.allowManagedHooksOnly === true,
  };
}

/** The marketplace manifest file at a source root. */
export const MARKETPLACE_MANIFEST_FILE = 'brainrouter-marketplace.json';

/** kebab-ish marketplace name (mirrors the plugin name rule, loosely). */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export interface MarketplaceAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/**
 * A plugin entry in a marketplace manifest. `source` is the plugin's
 * location RELATIVE TO the marketplace source, one of:
 *   - `./relative`               → bundled inside the marketplace repo/dir
 *   - `git+https://…/r.git#tag`  → a standalone plugin repo (pinned)
 *   - `https://…/plugin.tgz`     → a downloadable tarball (Phase 3+)
 */
export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  source: string;
  version?: string;
  category?: string;
  author?: MarketplaceAuthor;
  /** PLUGIN-MARKETPLACE P3 — expected sha256 integrity for a remote artifact. */
  integrity?: string;
}

export interface MarketplaceManifest {
  name: string;
  owner?: MarketplaceAuthor;
  plugins: MarketplacePluginEntry[];
}

export interface MarketplaceParseResult {
  valid: boolean;
  manifest?: MarketplaceManifest;
  errors: string[];
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseAuthor(v: unknown): MarketplaceAuthor | undefined {
  if (typeof v === 'string') return v.trim() ? { name: v.trim() } : undefined;
  if (!isPlainObject(v)) return undefined;
  const out: MarketplaceAuthor = {};
  if (typeof v.name === 'string' && v.name.trim()) out.name = v.name.trim();
  if (typeof v.email === 'string' && v.email.trim()) out.email = v.email.trim();
  if (typeof v.url === 'string' && v.url.trim()) out.url = v.url.trim();
  return Object.keys(out).length ? out : undefined;
}

/** Parse + validate a marketplace manifest object (already JSON-parsed). */
export function validateMarketplaceManifest(raw: unknown): MarketplaceParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return { valid: false, errors: ['marketplace manifest must be a JSON object'], warnings };

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.push('marketplace.name is required');

  const plugins: MarketplacePluginEntry[] = [];
  if (!Array.isArray(raw.plugins)) {
    errors.push('marketplace.plugins must be an array');
  } else {
    const seen = new Set<string>();
    raw.plugins.forEach((p, i) => {
      if (!isPlainObject(p)) { warnings.push(`plugins[${i}] is not an object — skipped`); return; }
      const pName = typeof p.name === 'string' ? p.name.trim() : '';
      const source = typeof p.source === 'string' ? p.source.trim() : '';
      if (!pName) { warnings.push(`plugins[${i}] missing name — skipped`); return; }
      if (!source) { warnings.push(`plugin "${pName}" missing source — skipped`); return; }
      if (seen.has(pName)) { warnings.push(`duplicate plugin "${pName}" — first wins`); return; }
      seen.add(pName);
      const entry: MarketplacePluginEntry = { name: pName, source };
      if (typeof p.description === 'string' && p.description.trim()) entry.description = p.description.trim();
      if (typeof p.version === 'string' && p.version.trim()) entry.version = p.version.trim();
      if (typeof p.category === 'string' && p.category.trim()) entry.category = p.category.trim();
      if (typeof p.integrity === 'string' && p.integrity.trim()) entry.integrity = p.integrity.trim();
      const author = parseAuthor(p.author);
      if (author) entry.author = author;
      plugins.push(entry);
    });
  }

  if (errors.length) return { valid: false, errors, warnings };
  const manifest: MarketplaceManifest = { name, plugins };
  const owner = parseAuthor(raw.owner);
  if (owner) manifest.owner = owner;
  return { valid: true, manifest, errors, warnings };
}

/** Parse marketplace manifest JSON text → validation result. Never throws. */
export function parseMarketplaceManifest(text: string): MarketplaceParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${(err as Error).message}`], warnings: [] };
  }
  return validateMarketplaceManifest(raw);
}

/** Read a marketplace manifest from a checked-out/local marketplace dir. */
export function readMarketplaceManifestAt(dir: string, altManifestNames: readonly string[] = []): MarketplaceParseResult {
  const names = marketplaceManifestFilenames(altManifestNames);
  const file = names.map((name) => path.join(dir, name)).find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  let text: string;
  try {
    if (!file) throw new Error('missing marketplace manifest');
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { valid: false, errors: [`missing ${names.join('|')} at ${dir}`], warnings: [] };
  }
  return parseMarketplaceManifest(text);
}

function marketplaceManifestFilenames(altManifestNames: readonly string[]): string[] {
  const out = [MARKETPLACE_MANIFEST_FILE];
  const seen = new Set(out);
  for (const raw of altManifestNames) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    if (name.includes('/') || name.includes('\\')) continue;
    if (!name.endsWith('.json')) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config record helpers — cli.plugins.marketplaces[]
// ---------------------------------------------------------------------------

/** Classify a marketplace source string into a `sourceType`. */
export function classifyMarketplaceSource(source: string): MarketplaceSource['sourceType'] {
  const s = source.trim();
  if (/^https?:\/\/.+\.(tgz|tar\.gz)(\?.*)?$/i.test(s)) return 'http';
  if (classifySource(s) === 'git') return 'git';
  return 'local';
}

function marketplacesOf(config: Config): MarketplaceSource[] {
  return config.cli?.plugins?.marketplaces ?? [];
}

function withMarketplaces(config: Config, next: MarketplaceSource[]): Config {
  const cli = config.cli ?? {};
  const plugins = cli.plugins ?? {};
  return { ...config, cli: { ...cli, plugins: { ...plugins, marketplaces: next } } };
}

export interface AddMarketplaceResult {
  ok: boolean;
  entry?: MarketplaceSource;
  error?: string;
}

/** Add (or replace) a marketplace source in a config, returning the mutated config. */
export function addMarketplaceIn(
  config: Config,
  name: string,
  source: string,
  opts: { ref?: string; sparsePaths?: string[]; sourceType?: MarketplaceSource['sourceType']; force?: boolean } = {},
): AddMarketplaceResult & { config?: Config } {
  const cleanName = name.trim();
  const cleanSource = source.trim();
  if (!cleanName || !NAME_RE.test(cleanName)) return { ok: false, error: `invalid marketplace name "${name}"` };
  if (!cleanSource) return { ok: false, error: 'marketplace source is required' };
  // P3 — managed gating: refuse a blocked / non-allowlisted marketplace at add time.
  const gateErr = assertMarketplaceAllowed(cleanName, gatesFromConfig(config));
  if (gateErr) return { ok: false, error: gateErr };
  const list = marketplacesOf(config);
  const existing = list.find((m) => m.name === cleanName);
  if (existing && !opts.force) return { ok: false, error: `marketplace "${cleanName}" already exists (use force to replace)` };
  const entry: MarketplaceSource = {
    name: cleanName,
    sourceType: opts.sourceType ?? classifyMarketplaceSource(cleanSource),
    source: cleanSource,
  };
  if (opts.ref?.trim()) entry.ref = opts.ref.trim();
  if (opts.sparsePaths?.length) entry.sparsePaths = opts.sparsePaths.map((p) => p.trim()).filter(Boolean);
  const next = list.filter((m) => m.name !== cleanName).concat(entry);
  return { ok: true, entry, config: withMarketplaces(config, next) };
}

/** Remove a marketplace source from a config. */
export function removeMarketplaceIn(config: Config, name: string): { ok: boolean; config?: Config; error?: string } {
  const list = marketplacesOf(config);
  if (!list.some((m) => m.name === name)) return { ok: false, error: `marketplace "${name}" not found` };
  return { ok: true, config: withMarketplaces(config, list.filter((m) => m.name !== name)) };
}

/** List the configured marketplace sources. */
export function listMarketplaces(config?: Config): MarketplaceSource[] {
  return marketplacesOf(config ?? loadOrInitConfig());
}

/** Persisting convenience: add a marketplace + save config. */
export function addMarketplace(
  name: string,
  source: string,
  opts: { ref?: string; sparsePaths?: string[]; sourceType?: MarketplaceSource['sourceType']; force?: boolean } = {},
): AddMarketplaceResult {
  const res = addMarketplaceIn(loadOrInitConfig(), name, source, opts);
  if (!res.ok || !res.config) return res;
  saveConfig(res.config);
  return { ok: true, entry: res.entry };
}

/** Persisting convenience: remove a marketplace + save config. */
export function removeMarketplace(name: string): { ok: boolean; error?: string } {
  const res = removeMarketplaceIn(loadOrInitConfig(), name);
  if (!res.ok || !res.config) return { ok: false, error: res.error };
  saveConfig(res.config);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Fetch a marketplace's checkout → read its manifest
// ---------------------------------------------------------------------------

function rmrf(target: string): void {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

function parseGitUrl(source: string): { url: string; ref?: string } {
  let s = source.trim().replace(/^git\+/, '');
  let ref: string | undefined;
  const hash = s.lastIndexOf('#');
  if (hash >= 0) { ref = s.slice(hash + 1) || undefined; s = s.slice(0, hash); }
  return { url: s, ref };
}

export interface FetchedMarketplace {
  /** Absolute dir holding a checked-out/located copy of the marketplace. */
  dir: string;
  /** For a git checkout: a temp dir the caller should clean when done. */
  cleanup?: () => void;
  /** HEAD revision for a git checkout. */
  revision?: string;
}

export type FetchMarketplaceResult =
  | { ok: true; fetched: FetchedMarketplace }
  | { ok: false; error: string };

/**
 * Fetch a marketplace source to a local directory. `local` reads in place; `git`
 * clones into a temp dir (honoring `ref`). `http` tarball fetch is deferred to a
 * later phase (returns an explanatory error for now).
 */
export function fetchMarketplace(entry: MarketplaceSource): FetchMarketplaceResult {
  if (entry.sourceType === 'local') {
    const abs = path.resolve(entry.source);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return { ok: false, error: `local marketplace not found: ${abs}` }; }
    if (!stat.isDirectory()) return { ok: false, error: `local marketplace is not a directory: ${abs}` };
    return { ok: true, fetched: { dir: abs } };
  }
  if (entry.sourceType === 'git') {
    const { url, ref: urlRef } = parseGitUrl(entry.source);
    const ref = entry.ref ?? urlRef;
    const dir = path.join(stagingDir(), `market-${randomUUID()}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const cleanup = (): void => rmrf(dir);
    const cloneArgs = ['clone', '--depth', '1'];
    if (ref) cloneArgs.push('--branch', ref);
    cloneArgs.push(url, dir);
    let clone = spawnSync('git', cloneArgs, { encoding: 'utf8' });
    if (clone.status !== 0) {
      rmrf(dir);
      clone = spawnSync('git', ['clone', url, dir], { encoding: 'utf8' });
      if (clone.status !== 0) { cleanup(); return { ok: false, error: `git clone failed: ${(clone.stderr || '').trim()}` }; }
      if (ref) {
        const co = spawnSync('git', ['-C', dir, 'checkout', ref], { encoding: 'utf8' });
        if (co.status !== 0) { cleanup(); return { ok: false, error: `git checkout ${ref} failed: ${(co.stderr || '').trim()}` }; }
      }
    }
    const rev = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const revision = rev.status === 0 ? rev.stdout.trim() : undefined;
    return { ok: true, fetched: { dir, cleanup, revision } };
  }
  return { ok: false, error: `http marketplace sources are not supported yet (${entry.name})` };
}

// ---------------------------------------------------------------------------
// marketplace update — refresh a source + record revision
// ---------------------------------------------------------------------------

export interface UpdateMarketplaceResult {
  ok: boolean;
  name: string;
  revision?: string;
  plugins?: number;
  error?: string;
}

/**
 * Refresh a single marketplace: re-fetch, read its manifest (to count plugins +
 * validate), and record the new revision + timestamp in config. For `local`
 * sources there's nothing to pull, but the manifest is re-read + validated.
 * Returns the updated config alongside the result so callers can batch saves.
 */
export function updateMarketplaceIn(config: Config, name: string): UpdateMarketplaceResult & { config?: Config } {
  const list = marketplacesOf(config);
  const entry = list.find((m) => m.name === name);
  if (!entry) return { ok: false, name, error: `marketplace "${name}" not found` };
  const fetched = fetchMarketplace(entry);
  if (!fetched.ok) return { ok: false, name, error: fetched.error };
  try {
    const parsed = readMarketplaceManifestAt(fetched.fetched.dir, resolveCliKnobs(config).plugins.altManifestNames);
    if (!parsed.valid || !parsed.manifest) {
      return { ok: false, name, error: `invalid marketplace manifest: ${parsed.errors.join('; ')}` };
    }
    const updated: MarketplaceSource = {
      ...entry,
      lastRevision: fetched.fetched.revision ?? entry.lastRevision,
      lastUpdated: new Date().toISOString(),
    };
    const nextConfig = withMarketplaces(config, list.map((m) => (m.name === name ? updated : m)));
    return { ok: true, name, revision: updated.lastRevision, plugins: parsed.manifest.plugins.length, config: nextConfig };
  } finally {
    fetched.fetched.cleanup?.();
  }
}

/** Persisting convenience: update one marketplace (or all when name omitted). */
export function updateMarketplaces(name?: string): UpdateMarketplaceResult[] {
  let config = loadOrInitConfig();
  const targets = name ? [name] : marketplacesOf(config).map((m) => m.name);
  const results: UpdateMarketplaceResult[] = [];
  for (const t of targets) {
    const res = updateMarketplaceIn(config, t);
    if (res.config) config = res.config;
    results.push({ ok: res.ok, name: res.name, revision: res.revision, plugins: res.plugins, error: res.error });
  }
  saveConfig(config);
  return results;
}

// ---------------------------------------------------------------------------
// install-by-name — resolve a plugin across configured marketplaces
// ---------------------------------------------------------------------------

export interface ResolvedMarketplacePlugin {
  marketplace: string;
  entry: MarketplacePluginEntry;
  fetched: FetchedMarketplace;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedMarketplacePlugin }
  | { ok: false; error: string };

/**
 * Find a plugin by NAME across every configured marketplace (first match wins,
 * in config order). Fetches each marketplace's manifest lazily. The caller MUST
 * call `resolved.fetched.cleanup?.()` when done (a git checkout leaves a temp).
 */
export function resolvePluginByName(name: string, config?: Config): ResolveResult {
  const cfg = config ?? loadOrInitConfig();
  const altManifestNames = resolveCliKnobs(cfg).plugins.altManifestNames;
  const list = marketplacesOf(cfg);
  if (list.length === 0) return { ok: false, error: 'no marketplaces configured (add one with `brainrouter marketplace add`)' };
  const gates = gatesFromConfig(cfg);
  const errors: string[] = [];
  for (const mkt of list) {
    // P3 — skip any marketplace the managed policy blocks / doesn't allowlist.
    const gateErr = assertMarketplaceAllowed(mkt.name, gates);
    if (gateErr) { errors.push(`${mkt.name}: ${gateErr}`); continue; }
    const fetched = fetchMarketplace(mkt);
    if (!fetched.ok) { errors.push(`${mkt.name}: ${fetched.error}`); continue; }
    const parsed = readMarketplaceManifestAt(fetched.fetched.dir, altManifestNames);
    if (!parsed.valid || !parsed.manifest) {
      errors.push(`${mkt.name}: ${parsed.errors.join('; ')}`);
      fetched.fetched.cleanup?.();
      continue;
    }
    const entry = parsed.manifest.plugins.find((p) => p.name === name);
    if (entry) {
      // ADR-047 D4 — the plugin gate, between resolve and install: refuse a
      // blocked / non-allowlisted plugin by name of the policy (the marketplace
      // gate above only decides whole marketplaces).
      const pluginGateErr = assertPluginAllowed(entry.name, gates);
      if (pluginGateErr) {
        fetched.fetched.cleanup?.();
        return { ok: false, error: pluginGateErr };
      }
      return { ok: true, resolved: { marketplace: mkt.name, entry, fetched: fetched.fetched } };
    }
    fetched.fetched.cleanup?.();
  }
  const detail = errors.length ? ` (${errors.join('; ')})` : '';
  return { ok: false, error: `plugin "${name}" not found in any configured marketplace${detail}` };
}

/**
 * Turn a resolved marketplace plugin's `source` into the install `source` +
 * `InstallOptions` for P1's `installPlugin`. Handles the three source forms:
 *   - `./relative`               → local install of `<marketplaceDir>/relative`
 *   - `git+https://…/r.git#tag`  → git install (pinned)
 *   - `https://…/plugin.tgz`     → deferred (http tarball) → error
 */
export function resolvePluginInstallSpec(
  resolved: ResolvedMarketplacePlugin,
): { ok: true; source: string; opts: Pick<InstallOptions, 'ref' | 'subPath' | 'marketplace' | 'integrity'> } | { ok: false; error: string } {
  const { entry, fetched, marketplace } = resolved;
  const src = entry.source.trim();
  const integrity = entry.integrity; // P3 — verified before the staged copy goes live
  // git+... or a bare git url with a possible #ref
  if (/^git\+/.test(src) || classifySource(src) === 'git') {
    const { url, ref } = parseGitUrl(src);
    return { ok: true, source: url, opts: { ref: entry.version ? undefined : ref, marketplace, integrity } };
  }
  // http tarball — deferred to a later phase
  if (/^https?:\/\//i.test(src)) {
    return { ok: false, error: `http plugin sources are not supported yet ("${entry.name}")` };
  }
  // relative path inside the marketplace repo/dir → install the whole checkout
  // from the marketplace root, narrowing to the plugin's sub-path.
  const rel = src.replace(/^\.\//, '').replace(/^[/\\]+/, '');
  const abs = path.resolve(fetched.dir, rel);
  const relToRoot = path.relative(fetched.dir, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { ok: false, error: `plugin source "${src}" resolves outside the marketplace` };
  }
  return { ok: true, source: abs, opts: { marketplace, integrity } };
}

export interface InstallByNameResult {
  ok: boolean;
  marketplace?: string;
  result?: InstallResult;
  error?: string;
}

/**
 * Install a plugin BY NAME: resolve it across marketplaces, then reuse P1's
 * atomic `installPlugin`. A failed install leaves any prior version intact
 * (P1 atomic-staging guarantee). Always cleans up the marketplace checkout.
 */
export function installPluginByName(
  name: string,
  opts: { scope?: InstallOptions['scope']; workspaceRoot?: string; force?: boolean; config?: Config } = {},
): InstallByNameResult {
  const config = opts.config ?? loadOrInitConfig();
  const altManifestNames = resolveCliKnobs(config).plugins.altManifestNames;
  const resolved = resolvePluginByName(name, config);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const spec = resolvePluginInstallSpec(resolved.resolved);
    if (!spec.ok) return { ok: false, marketplace: resolved.resolved.marketplace, error: spec.error };
    const result = installPlugin(spec.source, {
      scope: opts.scope,
      workspaceRoot: opts.workspaceRoot,
      force: opts.force,
      ref: spec.opts.ref,
      subPath: spec.opts.subPath,
      marketplace: spec.opts.marketplace,
      integrity: spec.opts.integrity,
      altManifestNames,
    });
    if (!result.ok) return { ok: false, marketplace: resolved.resolved.marketplace, result, error: result.error };
    return { ok: true, marketplace: resolved.resolved.marketplace, result };
  } finally {
    resolved.resolved.fetched.cleanup?.();
  }
}
