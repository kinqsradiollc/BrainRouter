// Track — git concern: canonical repo identity used to MATCH a linked GitHub repo
// to a local checkout (ADR-015). The join key between "a linked repo", a local
// working directory, and a cloud Project.repoUrl is the *normalized remote URL* —
// so it survives http↔ssh remotes, a trailing `.git`, a moved/renamed folder, or a
// second clone. Pure + dependency-light so desktop (electron), backend, and CLI can
// all share one definition.
import crypto from 'node:crypto';

/**
 * Canonicalize a git remote URL to a stable `host/owner/repo…` identity.
 *
 * Handles the three shapes git emits:
 *   - `https://github.com/owner/repo(.git)`
 *   - `git@github.com:owner/repo(.git)`            (scp-like, no scheme)
 *   - `ssh://git@github.com/owner/repo(.git)`      (and `git://`)
 *
 * Lowercased, credentials + trailing `.git` stripped. The full path after the host
 * is kept so nested groups (e.g. GitLab subgroups) match faithfully. Returns `''`
 * when the input is not a parseable remote (e.g. only `owner`, or junk).
 */
export function normalizeRepoUrl(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  let host = '';
  let path = '';
  // scp-like: [user@]host:path — single colon before the path, and no URL scheme.
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(s);
  if (scp && !s.includes('://')) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(s.includes('://') ? s : `https://${s}`);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return '';
    }
  }
  host = host.toLowerCase().replace(/^www\./, '');
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !path.includes('/')) return '';
  return `${host}/${path}`.toLowerCase();
}

/**
 * A short, stable tag from a normalized remote URL for scoping memory BY REPO
 * (survives a moved/renamed folder or a second clone — unlike a path hash). 16 hex
 * chars, matching the width of the existing workspace tag. `''` when unparseable.
 */
export function repoTag(raw: string): string {
  const norm = normalizeRepoUrl(raw);
  if (!norm) return '';
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** True when two remote URLs point at the same repo (ignoring http↔ssh / `.git`). */
export function sameRepo(a: string, b: string): boolean {
  const na = normalizeRepoUrl(a);
  return !!na && na === normalizeRepoUrl(b);
}

/**
 * Find the linked repo whose URL points at the same repo as a workspace's remote —
 * the core of "match this local checkout to a linked GitHub repo" (ADR-015). Works
 * for the cloud Project shape (`repoUrl`) and any `{ url }` shape (desktop connector
 * repos). Returns the first match, or null.
 */
export function matchLinkedRepo<T extends { repoUrl?: string | null; url?: string | null }>(
  workspaceRemote: string,
  linked: readonly T[],
): T | null {
  const want = normalizeRepoUrl(workspaceRemote);
  if (!want) return null;
  return linked.find((r) => normalizeRepoUrl(r.repoUrl ?? r.url ?? '') === want) ?? null;
}
