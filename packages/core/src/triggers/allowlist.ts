/**
 * MC-B1 — repo allowlist for the trigger ingress. `cli.triggers.allowedRepos`
 * is a list of `owner/name` globs; the DEFAULT is the empty list, which
 * allows NOTHING. Non-allowlisted events are accepted-but-dropped (202) so a
 * probing caller can never enumerate which repos exist on this host.
 */

/** Compile one repo glob: `*` matches within a path segment, `**` across
 *  segments, `?` a single non-`/` char. Everything else is literal. */
export function repoGlobToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** True iff `repo` (an `owner/name` slug) matches at least one glob. An
 *  empty/missing repo or an empty allowlist is always denied (fail-closed). */
export function isRepoAllowed(repo: string, allowedRepos: readonly string[]): boolean {
  const slug = (repo ?? '').trim();
  if (!slug) return false;
  for (const raw of allowedRepos) {
    const glob = (raw ?? '').trim();
    if (!glob) continue;
    try {
      if (repoGlobToRegExp(glob).test(slug)) return true;
    } catch {
      // A malformed pattern allows nothing (never widens the gate).
    }
  }
  return false;
}
