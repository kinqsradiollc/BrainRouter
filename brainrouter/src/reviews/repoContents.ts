/**
 * Exact-revision reads through the forge's contents API (ADR-056 A7/B9).
 *
 * Everything the review surfaces show about a pull request is read AT THE
 * HEAD SHA — never a working tree, never a default branch. Bounded reads,
 * null on any miss (a deleted file, a directory, an API error) so a missing
 * artifact is a fact the caller reports, not a failed request.
 */
export interface RepoContentsInput {
  fetchImpl: typeof fetch;
  apiBase: string;
  repo: string;
  ref: string;
  headers: Record<string, string>;
}

export const REPO_CONTENTS_MAX_BYTES = 1024 * 1024;

function contentsUrl(input: RepoContentsInput, path: string): string {
  return `${input.apiBase}/repos/${input.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(input.ref)}`;
}

/** The text of one file at the ref, or null (missing, not a file, over the bound, or unreachable). */
export async function readRepoTextAtRef(input: RepoContentsInput, path: string, maxBytes = REPO_CONTENTS_MAX_BYTES): Promise<string | null> {
  try {
    const r = await input.fetchImpl(contentsUrl(input, path), { headers: { ...input.headers, Accept: 'application/vnd.github.raw' } });
    if (!r.ok) return null;
    const text = await r.text();
    return text.length > maxBytes ? null : text;
  } catch {
    return null;
  }
}

export interface RepoDirEntry { name: string; path: string; type: 'file' | 'dir' | 'symlink' | 'submodule'; size: number }

/** The entries of one directory at the ref, or [] when it does not exist. */
export async function listRepoDirAtRef(input: RepoContentsInput, dir: string): Promise<RepoDirEntry[]> {
  try {
    const r = await input.fetchImpl(contentsUrl(input, dir), { headers: { ...input.headers, Accept: 'application/vnd.github+json' } });
    if (!r.ok) return [];
    const json = await r.json() as unknown;
    if (!Array.isArray(json)) return [];
    return json
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({ name: String(e.name ?? ''), path: String(e.path ?? ''), type: (e.type === 'dir' || e.type === 'symlink' || e.type === 'submodule' ? e.type : 'file') as RepoDirEntry['type'], size: Number(e.size ?? 0) }))
      .filter((e) => e.name);
  } catch {
    return [];
  }
}
