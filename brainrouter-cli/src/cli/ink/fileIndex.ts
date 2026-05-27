/**
 * Lightweight workspace file index for @-mention autocompletion in the
 * chat composer. Walks the workspace root once and caches the result for
 * 30 seconds; subsequent reads return the cached list instantly.
 *
 * Ignores the usual heavy/uninteresting paths: node_modules, .git, dist,
 * .next, build outputs, lockfiles. Caps the result at 5000 entries so a
 * monorepo with hundreds of thousands of files doesn't pin the REPL.
 *
 * trimmed to what the Ink composer actually needs (fuzzy substring
 * scoring is good enough; we don't need full-blown trigram indexing).
 */
import fs from 'node:fs';
import path from 'node:path';

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache',
  '.turbo', '.vercel', '.parcel-cache', 'coverage', '.DS_Store',
  'out', 'tmp', '.tmp', '.idea', '.vscode',
]);

const MAX_ENTRIES = 5000;
const TTL_MS = 30_000;

interface IndexCache {
  root: string;
  entries: string[];
  expiresAt: number;
}

let cache: IndexCache | null = null;

function walk(root: string, rel: string, out: string[], depth: number): void {
  if (out.length >= MAX_ENTRIES) return;
  if (depth > 10) return;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (out.length >= MAX_ENTRIES) return;
    if (d.name.startsWith('.') && d.name !== '.env.example') {
      // Only ignore dotfiles that aren't conventionally referenced.
      if (IGNORED.has(d.name) || d.name === '.git') continue;
    }
    if (IGNORED.has(d.name)) continue;
    const childRel = rel ? path.join(rel, d.name) : d.name;
    if (d.isDirectory()) {
      walk(root, childRel, out, depth + 1);
    } else if (d.isFile()) {
      out.push(childRel);
    }
  }
}

export function getFileIndex(workspaceRoot: string): string[] {
  const now = Date.now();
  if (cache && cache.root === workspaceRoot && cache.expiresAt > now) {
    return cache.entries;
  }
  const entries: string[] = [];
  walk(workspaceRoot, '', entries, 0);
  cache = { root: workspaceRoot, entries, expiresAt: now + TTL_MS };
  return entries;
}

/**
 * Score-and-rank: matches files whose path *contains* the query as a
 * substring (case-insensitive). Ranks by:
 *   1. exact basename match (highest)
 *   2. basename starts-with
 *   3. path contains
 *   4. shorter path wins ties
 * Returns at most `limit` results.
 */
export function matchFiles(index: string[], query: string, limit = 8): string[] {
  if (!query) return [];
  const q = query.toLowerCase();
  type Scored = { p: string; score: number };
  const scored: Scored[] = [];
  for (const p of index) {
    const lower = p.toLowerCase();
    const base = path.basename(lower);
    let score: number | null = null;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    if (score === null) continue;
    scored.push({ p, score: score * 1000 + p.length });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.p);
}

/**
 * Extract the trailing `@token` from a composer value, or null if the
 * cursor isn't currently in one. Pure function so it's easy to test.
 *
 * Examples:
 *   "hello @src/fo" → "src/fo"
 *   "@src"          → "src"
 *   "no at"         → null
 *   "@foo bar"      → null  (space terminates the token)
 *   "@"             → ""    (empty trigger — show top entries)
 */
export function extractAtToken(value: string): string | null {
  const m = value.match(/(?:^|\s)@([^\s@]*)$/);
  return m ? m[1] : null;
}

/**
 * Replace the trailing `@token` in `value` with the chosen file path.
 * Appends a trailing space so the user can keep typing immediately.
 */
export function applyAtCompletion(value: string, filePath: string): string {
  return value.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
    const leading = match.startsWith('@') ? '' : match[0];
    return `${leading}@${filePath} `;
  });
}
