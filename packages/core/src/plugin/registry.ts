/**
 * PLUGIN-MARKETPLACE P3 — hosted registry index + search (plan §3.4/§4).
 *
 * A single `registry.json` (served from a BrainRouter-owned repo/CDN, or a local
 * file path for tests / air-gapped mirrors) powers discovery à la Gemini:
 *
 *   { "plugins": [ { id, name, repo, version, category, tags[], stars,
 *                    lastUpdated, integrity, author,
 *                    provides:{skills,agents,hooks,mcpServers,connectors,workflows} } ] }
 *
 * `brainrouter plugin search <q>` fetches this index (cached), ranks by relevance
 * then stars, and filters by category / tag. The registry URL comes from
 * `cli.plugins.registryUrl`, falling back to the built-in default constant.
 * Everything is additive + inert until a search is run.
 */
import fs from 'node:fs';

/** BrainRouter-owned default registry index. Overridable via `cli.plugins.registryUrl`. */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/kinqsradio/brainrouter-plugins/main/registry.json';

/** What each registry entry declares a plugin provides (counts). */
export interface RegistryProvides {
  skills?: number;
  agents?: number;
  hooks?: number;
  mcpServers?: number;
  connectors?: number;
  workflows?: number;
}

/** A single plugin entry in the hosted registry index (plan §3.4). */
export interface RegistryEntry {
  id: string;
  name: string;
  repo: string;
  version?: string;
  category?: string;
  tags: string[];
  stars: number;
  lastUpdated?: string;
  /** sha256 integrity (SRI form) for a remote/tarball artifact, when applicable. */
  integrity?: string;
  author?: string;
  description?: string;
  provides: RegistryProvides;
}

export interface RegistryIndex {
  plugins: RegistryEntry[];
}

export interface RegistryParseResult {
  valid: boolean;
  index?: RegistryIndex;
  errors: string[];
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toStringArray(v: unknown): string[] {
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

function parseProvides(v: unknown): RegistryProvides {
  const out: RegistryProvides = {};
  if (!isPlainObject(v)) return out;
  for (const k of ['skills', 'agents', 'hooks', 'mcpServers', 'connectors', 'workflows'] as const) {
    const n = v[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  return out;
}

/** Parse + validate a registry index object (already JSON-parsed). Fail-safe:
 *  malformed entries are dropped with a warning rather than voiding the index. */
export function validateRegistryIndex(raw: unknown): RegistryParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) return { valid: false, errors: ['registry must be a JSON object'], warnings };
  if (!Array.isArray(raw.plugins)) return { valid: false, errors: ['registry.plugins must be an array'], warnings };

  const plugins: RegistryEntry[] = [];
  const seen = new Set<string>();
  raw.plugins.forEach((p, i) => {
    if (!isPlainObject(p)) { warnings.push(`plugins[${i}] is not an object — skipped`); return; }
    const id = typeof p.id === 'string' ? p.id.trim() : (typeof p.name === 'string' ? p.name.trim() : '');
    const name = typeof p.name === 'string' ? p.name.trim() : id;
    const repo = typeof p.repo === 'string' ? p.repo.trim() : '';
    if (!id) { warnings.push(`plugins[${i}] missing id/name — skipped`); return; }
    if (seen.has(id)) { warnings.push(`duplicate registry id "${id}" — first wins`); return; }
    seen.add(id);
    const stars = typeof p.stars === 'number' && Number.isFinite(p.stars) && p.stars >= 0 ? Math.floor(p.stars) : 0;
    const entry: RegistryEntry = {
      id,
      name: name || id,
      repo,
      tags: toStringArray(p.tags),
      stars,
      provides: parseProvides(p.provides),
    };
    if (typeof p.version === 'string' && p.version.trim()) entry.version = p.version.trim();
    if (typeof p.category === 'string' && p.category.trim()) entry.category = p.category.trim();
    if (typeof p.lastUpdated === 'string' && p.lastUpdated.trim()) entry.lastUpdated = p.lastUpdated.trim();
    if (typeof p.integrity === 'string' && p.integrity.trim()) entry.integrity = p.integrity.trim();
    if (typeof p.author === 'string' && p.author.trim()) entry.author = p.author.trim();
    if (typeof p.description === 'string' && p.description.trim()) entry.description = p.description.trim();
    plugins.push(entry);
  });

  return { valid: true, index: { plugins }, errors, warnings };
}

/** Parse registry JSON text → validation result. Never throws. */
export function parseRegistryIndex(text: string): RegistryParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${(err as Error).message}`], warnings: [] };
  }
  return validateRegistryIndex(raw);
}

// ---------------------------------------------------------------------------
// Fetch (local file OR http) with a small in-process cache
// ---------------------------------------------------------------------------

/** Resolve the effective registry URL: an explicit override, else the default. */
export function resolveRegistryUrl(registryUrl?: string): string {
  const u = (registryUrl ?? '').trim();
  return u || DEFAULT_REGISTRY_URL;
}

/** True when a registry location is a local file path (not http(s)). */
function isLocalPath(location: string): boolean {
  return !/^https?:\/\//i.test(location.trim());
}

interface CacheEntry { at: number; index: RegistryIndex; }
const registryCache = new Map<string, CacheEntry>();
/** Cache TTL — a short window so repeated searches in one session don't re-fetch. */
export const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the in-process registry cache (tests). */
export function clearRegistryCache(): void {
  registryCache.clear();
}

export type FetchRegistryResult =
  | { ok: true; index: RegistryIndex; fromCache: boolean; warnings: string[] }
  | { ok: false; error: string };

/**
 * Fetch + parse a registry index from `location` (a local file path or an
 * http(s) URL), cached for `REGISTRY_CACHE_TTL_MS`. `force` bypasses the cache.
 * An http fetch uses the global `fetch` (Node 18+); a network / parse failure is
 * a soft error the caller surfaces.
 */
export async function fetchRegistry(
  location: string,
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<FetchRegistryResult> {
  const loc = location.trim();
  const ttl = opts.ttlMs ?? REGISTRY_CACHE_TTL_MS;
  const cached = registryCache.get(loc);
  if (!opts.force && cached && Date.now() - cached.at < ttl) {
    return { ok: true, index: cached.index, fromCache: true, warnings: [] };
  }

  let text: string;
  try {
    if (isLocalPath(loc)) {
      text = fs.readFileSync(loc, 'utf8');
    } else {
      const res = await fetch(loc);
      if (!res.ok) return { ok: false, error: `registry fetch failed: HTTP ${res.status}` };
      text = await res.text();
    }
  } catch (err) {
    return { ok: false, error: `registry fetch failed: ${(err as Error).message}` };
  }

  const parsed = parseRegistryIndex(text);
  if (!parsed.valid || !parsed.index) return { ok: false, error: `invalid registry: ${parsed.errors.join('; ')}` };
  registryCache.set(loc, { at: Date.now(), index: parsed.index });
  return { ok: true, index: parsed.index, fromCache: false, warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Search — rank (relevance then stars) + filter (category / tag)
// ---------------------------------------------------------------------------

export interface SearchOptions {
  category?: string;
  tag?: string;
  limit?: number;
}

export interface SearchHit {
  entry: RegistryEntry;
  score: number;
}

/** Relevance score of a query against an entry (0 = no textual match). Name hits
 *  outrank tag / description hits; an empty query matches everything at score 0
 *  (so results fall back to a pure star sort — a plain browse). */
function relevance(entry: RegistryEntry, q: string): number {
  const query = q.trim().toLowerCase();
  if (!query) return 0;
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const desc = (entry.description ?? '').toLowerCase();
  const tags = entry.tags.map((t) => t.toLowerCase());
  let score = 0;
  if (name === query || id === query) score += 100;
  else if (name.startsWith(query) || id.startsWith(query)) score += 60;
  else if (name.includes(query) || id.includes(query)) score += 40;
  if (tags.some((t) => t === query)) score += 30;
  else if (tags.some((t) => t.includes(query))) score += 15;
  if (desc.includes(query)) score += 10;
  return score;
}

/**
 * Search a parsed registry index. Filters by `category` / `tag` first, then
 * ranks by relevance (descending), breaking ties by stars (descending) then
 * name. An empty query returns every entry passing the filters, star-sorted.
 */
export function searchRegistry(index: RegistryIndex, query: string, opts: SearchOptions = {}): SearchHit[] {
  const cat = (opts.category ?? '').trim().toLowerCase();
  const tag = (opts.tag ?? '').trim().toLowerCase();
  const q = (query ?? '').trim();

  const filtered = index.plugins.filter((e) => {
    if (cat && (e.category ?? '').toLowerCase() !== cat) return false;
    if (tag && !e.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (q && relevance(e, q) === 0) return false; // require a textual match when a query is given
    return true;
  });

  const hits = filtered.map((entry) => ({ entry, score: relevance(entry, q) }));
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.entry.stars !== a.entry.stars) return b.entry.stars - a.entry.stars;
    return a.entry.name.localeCompare(b.entry.name);
  });
  const limit = opts.limit && opts.limit > 0 ? opts.limit : hits.length;
  return hits.slice(0, limit);
}

/** Convenience: fetch the configured registry + search in one call. */
export async function fetchAndSearch(
  registryUrl: string | undefined,
  query: string,
  opts: SearchOptions & { force?: boolean } = {},
): Promise<{ ok: true; hits: SearchHit[]; fromCache: boolean } | { ok: false; error: string }> {
  const res = await fetchRegistry(resolveRegistryUrl(registryUrl), { force: opts.force });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, hits: searchRegistry(res.index, query, opts), fromCache: res.fromCache };
}

/** Look up a single registry entry by id/name (exact, case-insensitive). */
export function findRegistryEntry(index: RegistryIndex, idOrName: string): RegistryEntry | undefined {
  const key = idOrName.trim().toLowerCase();
  return index.plugins.find((e) => e.id.toLowerCase() === key || e.name.toLowerCase() === key);
}
