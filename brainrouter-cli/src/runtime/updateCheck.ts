import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../version.js';
import { getConfigPath } from '../config/config.js';

/**
 * CLI-22 (0.4.4) — "you're N versions behind" notice. Throttled + cached so it
 * hits npm at most once per window (default 24h), bounded by a short timeout,
 * and fully fire-and-forget so it never delays or blocks startup. The pure
 * pieces (semver compare, freshness, banner) are injectable for tests; the
 * default path shells out to `npm view`.
 */

const PKG = '@kinqs/brainrouter-cli';
const DEFAULT_THROTTLE_MS = 24 * 60 * 60 * 1000; // once a day
const DEFAULT_NPM_TIMEOUT_MS = 4000;

export interface UpdateCheckResult {
  current: string;
  latest: string;
  behind: boolean;
  command: string;
}

interface UpdateCache {
  checkedAt: string; // ISO
  latest: string;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Numeric dotted compare; pre-release tags ignored. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => (v || '').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A one-line, dim notice. Returns '' when not behind. */
export function formatUpdateBanner(current: string, latest: string, command: string): string {
  if (compareSemver(current, latest) >= 0) return '';
  return `↑ brainrouter ${latest} is available (you have ${current}). Update: ${command}`;
}

function cachePath(): string {
  return path.join(path.dirname(getConfigPath()), 'update-check.json');
}

function readCache(file: string): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(file: string, cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache), 'utf-8');
  } catch {
    /* best-effort — a read-only home just means we re-check next launch */
  }
}

/** True when `checkedAt` is within `throttleMs` of `nowMs`. */
export function isCacheFresh(checkedAt: string | undefined, nowMs: number, throttleMs: number): boolean {
  if (!checkedAt) return false;
  const t = Date.parse(checkedAt);
  return Number.isFinite(t) && nowMs - t < throttleMs;
}

function npmViewLatest(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['view', PKG, 'version'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      const v = String(stdout || '').trim();
      resolve(/^\d+\.\d+\.\d+/.test(v) ? v : null);
    });
  });
}

/**
 * Resolve the current update status. Uses the cached `latest` while it's fresh,
 * otherwise fetches + re-caches. Returns null on any failure (offline, npm
 * missing, etc.) — the notice is strictly best-effort. Injectables make it
 * deterministic in tests.
 */
export async function checkForUpdate(opts?: {
  throttleMs?: number;
  npmTimeoutMs?: number;
  current?: string;
  nowMs?: number;
  cacheFile?: string;
  fetchLatest?: (timeoutMs: number) => Promise<string | null>;
}): Promise<UpdateCheckResult | null> {
  const current = opts?.current ?? VERSION;
  const throttleMs = opts?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  const file = opts?.cacheFile ?? cachePath();
  const fetchLatest = opts?.fetchLatest ?? npmViewLatest;

  let latest: string | null = null;
  const cache = readCache(file);
  if (cache && isCacheFresh(cache.checkedAt, nowMs, throttleMs)) {
    latest = cache.latest;
  } else {
    latest = await fetchLatest(opts?.npmTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS);
    if (latest) writeCache(file, { checkedAt: new Date(nowMs).toISOString(), latest });
    else if (cache) latest = cache.latest; // fall back to a stale cache when offline
  }
  if (!latest) return null;

  const command = `npm i -g ${PKG}@latest`;
  return { current, latest, behind: compareSemver(current, latest) < 0, command };
}
