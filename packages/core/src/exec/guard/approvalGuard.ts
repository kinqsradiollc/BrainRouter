/**
 * CODEX-APPROVAL-GUARD (0.4.7) — reject over-broad persistent approval prefixes.
 *
 * `cli.commandAllowlist` (CODEX-EXEC-POLICY) lets a user pre-approve command
 * prefixes so matching `run_command` calls skip the prompt. A prefix that is too
 * broad would quietly approve *everything* — e.g. allowlisting bare `git` also
 * approves `git push --force`; allowlisting `bash` approves `bash -c 'rm -rf /'`.
 * Codex blocks the same broad suggested prefixes (`exec_policy.rs:52`).
 *
 * This guard runs where the allowlist is read (`resolveCliKnobs`), so an
 * over-broad entry is **never honored** regardless of how it reached
 * `config.json`. Pure + signature-based.
 */

/**
 * Interpreters, shells, privilege-escalators and command-wrappers: any prefix
 * whose head is one of these is over-broad on its own — the rest of the command
 * is arbitrary, so the prefix grants approval to anything.
 */
const BROAD_HEADS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash',
  'python', 'python2', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua',
  'sudo', 'doas', 'su', 'env', 'osascript', 'eval', 'exec', 'source', '.',
  'xargs', 'nohup', 'time', 'watch', 'nice', 'setsid', 'script', 'command',
  'npx', 'pnpx', 'bunx', 'dlx',
]);

/**
 * Multiplexers that dispatch to wildly different effects per subcommand: a bare
 * prefix (no subcommand) is over-broad (`git` ⊇ `git push --force`), but a
 * qualified prefix (`git status`) is specific enough to allow.
 */
const MULTIPLEXER_HEADS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'cargo', 'go', 'make',
  'terraform', 'aws', 'gcloud', 'az', 'brew', 'apt', 'apt-get', 'pip', 'pip3',
  'systemctl', 'gh', 'helm', 'pulumi',
]);

/** Resolve a prefix's head program (skip `FOO=bar` env-assignments, strip path). */
function headOf(prefix: string): { head: string; qualifiers: string[] } {
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const raw = tokens[i] ?? '';
  const head = (raw.split('/').pop() ?? raw).toLowerCase();
  return { head, qualifiers: tokens.slice(i + 1) };
}

/**
 * True when `prefix` is too broad to safely persist as an auto-approval rule.
 * Empty, shell/interpreter/escalator heads, and bare multiplexers are rejected.
 */
export function isOverBroadCommandPrefix(prefix: string): boolean {
  const trimmed = (prefix ?? '').trim();
  if (!trimmed) return true; // an empty prefix matches everything
  // A prefix containing a shell control operator could chain into anything.
  if (/(\|\||&&|[|;&]|\$\(|`)/.test(trimmed)) return true;
  const { head, qualifiers } = headOf(trimmed);
  if (!head) return true;
  if (BROAD_HEADS.has(head)) return true;
  if (MULTIPLEXER_HEADS.has(head) && qualifiers.length === 0) return true;
  return false;
}

export interface SanitizedAllowlist {
  allowed: string[];
  rejected: string[];
}

/**
 * Split an allowlist into the entries safe to honor and the over-broad ones
 * that are dropped. Order-preserving; de-dupes by trimmed text.
 */
export function sanitizeCommandAllowlist(entries: string[]): SanitizedAllowlist {
  const allowed: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries ?? []) {
    const entry = (raw ?? '').trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    if (isOverBroadCommandPrefix(entry)) rejected.push(entry);
    else allowed.push(entry);
  }
  return { allowed, rejected };
}
