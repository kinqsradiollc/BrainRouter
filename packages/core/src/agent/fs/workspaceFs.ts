import fs from 'node:fs';
import path from 'node:path';

/**
 * REFAC-APPLY-PATCH-MODULE (0.4.6) — workspace filesystem primitives, extracted
 * verbatim from `agent.ts` so path containment + glob walking live in one small,
 * testable module (and so `applyPatch.ts` can depend on `resolveWorkspacePath`
 * without importing the whole agent). No behavior change. Re-exported from
 * `agent.ts` for back-compat with existing importers.
 */

/** Directories never descended into during a glob walk. */
// Non-source trees skipped by glob_files / grep_search. Besides build + VCS dirs,
// this skips `.claude` (which can hold full repo COPIES under `.claude/worktrees/`)
// and `.brainrouter*` (CLI state + its own worktrees) — walking those made
// glob/grep crawl for 20s+ and surface confusing duplicate matches. Real
// source/peer dirs (incl. vendored `openSrc/`) are NOT ignored.
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', '.DS_Store', '.next', '.open-next',
  '.claude', '.brainrouter', '.brainrouter.migrated', 'coverage', '.turbo', '.cache',
]);

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * ADR-042 D1 — a session's workspace is a set of attached roots, not one root.
 * A `WorkspaceScope` carries the identity-anchoring PRIMARY root (prompts, memory
 * bucket, code index — unchanged) plus zero or more ATTACHED roots (worktrees of
 * the same repo, entered explicitly). A path resolves when it is inside ANY root;
 * everything else keeps the verbatim escape error. This is a widening of the
 * jail's door list, never a removal of the jail.
 */
export interface WorkspaceScope {
  /** The identity anchor — relative paths resolve against it; unchanged semantics. */
  readonly primaryRoot: string;
  /** Additional roots the session may read/write (ADR-042: same-repo worktrees). */
  readonly attachedRoots: readonly string[];
  /**
   * ADR-042 D6 — roots attached READ-ONLY (a worktree a live foreign session
   * owns). Readable like any other root; writes into them are excluded from the
   * write set here and refused with the owner named at the tool layer.
   */
  readonly readOnlyRoots?: readonly string[];
}

/** A single-root scope — the default that keeps every pre-ADR-042 caller unchanged. */
export function singleRootScope(primaryRoot: string): WorkspaceScope {
  return { primaryRoot, attachedRoots: [] };
}

/** All roots of a scope, primary first (the relative-path anchor). */
function scopeRoots(scope: WorkspaceScope): string[] {
  return [scope.primaryRoot, ...scope.attachedRoots];
}

/**
 * Core resolver: resolve `inputPath` against a set of roots. Relative paths
 * resolve against the FIRST root (the anchor); absolute paths as-is. The result
 * must sit inside at least one root — the DEEPEST matching one wins (ADR-042 E14),
 * so root-relative semantics (the read-before-edit ledger) bind to the worktree,
 * not a parent that happens to contain it. With one root this is byte-identical to
 * the pre-ADR-042 single-root behavior, including the escape messages.
 */
function resolveInScope(roots: readonly string[], inputPath: string, options: { forWrite?: boolean }): string {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('Path must be a non-empty string.');
  }
  const realRoots = roots.map((r) => fs.realpathSync(r));
  const anchor = realRoots[0];
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(anchor, inputPath);
  const checkPath = options.forWrite ? path.dirname(resolved) : resolved;
  const existingCheckPath = fs.existsSync(checkPath) ? fs.realpathSync(checkPath) : checkPath;

  // The deepest root that contains BOTH the resolved path and its (realpath'd)
  // existence check — deepest so a nested worktree wins over its parent (E14).
  const containing = realRoots
    .filter((r) => isPathInside(r, existingCheckPath) && isPathInside(r, resolved))
    .sort((a, b) => b.length - a.length)[0];
  if (!containing) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }

  // For writes we only canonicalize the PARENT above (the file may not exist
  // yet), so a pre-existing symlink AT the final path would be silently followed
  // by fs.writeFileSync — letting a write escape through `workspace/evil -> /etc`.
  // Reject writing through a symlink whose ultimate target leaves EVERY root
  // (live links resolve via realpath; dangling links fall back to the readlink
  // target). In-scope symlinks are allowed.
  if (options.forWrite) {
    let linkStat: fs.Stats | undefined;
    try { linkStat = fs.lstatSync(resolved); } catch { linkStat = undefined; }
    if (linkStat?.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(resolved);
      } catch {
        target = path.resolve(path.dirname(resolved), fs.readlinkSync(resolved));
      }
      if (!realRoots.some((r) => isPathInside(r, target))) {
        throw new Error(`Path escapes workspace root via symlink: ${inputPath}`);
      }
    }
  }

  return resolved;
}

/**
 * Resolve a workspace-relative path against the given workspaceRoot. Throws
 * if the result escapes the workspace.
 *
 * `workspaceRoot` is REQUIRED — passing a stale `process.cwd()` was the bug
 * that let tool writes land in `~/.brainrouter` when the user's cwd drifted.
 *
 * For backwards compatibility, the workspaceRoot parameter may be omitted; it
 * then falls back to process.cwd(). New code should always pass it explicitly.
 * Multi-root callers use {@link resolveWorkspacePathInScope}.
 */
export function resolveWorkspacePath(
  workspaceRootOrPath: string = '.',
  inputPathOrOptions?: string | { forWrite?: boolean },
  maybeOptions?: { forWrite?: boolean },
): string {
  // Two call shapes are supported during the migration of callers:
  //   resolveWorkspacePath(workspaceRoot, inputPath, options)
  //   resolveWorkspacePath(inputPath, options)   ← deprecated; falls back to cwd
  let workspaceRoot: string;
  let inputPath: string;
  let options: { forWrite?: boolean };
  if (typeof inputPathOrOptions === 'string') {
    workspaceRoot = workspaceRootOrPath;
    inputPath = inputPathOrOptions;
    options = maybeOptions ?? {};
  } else {
    workspaceRoot = fs.realpathSync(process.cwd());
    inputPath = workspaceRootOrPath;
    options = inputPathOrOptions ?? {};
  }
  return resolveInScope([workspaceRoot], inputPath, options);
}

/**
 * ADR-042 D1 — the multi-root form. Resolve a path against a whole
 * {@link WorkspaceScope}: inside the primary or any attached root. A single-root
 * scope is exactly {@link resolveWorkspacePath}.
 */
export function resolveWorkspacePathInScope(
  scope: WorkspaceScope,
  inputPath: string,
  options: { forWrite?: boolean } = {},
): string {
  // Writes resolve against the writable set (primary + read/write worktrees);
  // reads may also reach read-only attached worktrees (ADR-042 D6). Empty
  // readOnlyRoots ⇒ identical sets ⇒ byte-identical to the pre-D6 behavior.
  const writeRoots = scopeRoots(scope);
  const roots = options.forWrite ? writeRoots : [...writeRoots, ...(scope.readOnlyRoots ?? [])];
  return resolveInScope(roots, inputPath, options);
}

function globToRegexSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '.';
      continue;
    }

    source += char.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return source;
}

export function matchGlob(pattern: string, filePath: string): boolean {
  const base = path.basename(filePath);
  const convertPattern = (p: string) => new RegExp(`^${globToRegexSource(p)}$`);

  const normPath = filePath.replace(/\\/g, '/');
  if (convertPattern(pattern).test(normPath)) {
    return true;
  }

  if (!pattern.includes('/') && convertPattern(pattern).test(base)) {
    return true;
  }

  return false;
}

export function globFiles(pattern: string, workspaceRoot?: string, dir?: string): string[] {
  const wsRoot = fs.realpathSync(workspaceRoot ?? process.cwd());
  const startDir = dir ?? wsRoot;
  const safeDir = resolveWorkspacePath(wsRoot, path.relative(wsRoot, startDir) || '.');
  const results: string[] = [];
  const items = fs.readdirSync(safeDir);
  for (const item of items) {
    if (IGNORED_DIRS.has(item)) {
      continue;
    }
    const fullPath = path.join(safeDir, item);
    if (!isPathInside(wsRoot, fs.realpathSync(fullPath))) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...globFiles(pattern, wsRoot, fullPath));
    } else if (stat.isFile()) {
      const relPath = path.relative(wsRoot, fullPath);
      if (matchGlob(pattern, relPath)) {
        results.push(relPath);
      }
    }
  }
  return results;
}

export interface GrepHit { path: string; line: number; text: string; }

// GREP-HARDEN — guards so no single model-supplied query can block the host's
// main thread. `grep_search` compiles the query to a JS `RegExp` (backtracking
// engine) and runs it synchronously on every line; one pathological pattern on
// one long line (a minified bundle, a `.map`, a big JSON) is enough to peg the
// event loop for minutes and leave the session stuck "running". These caps bound
// every axis: line length (kills the backtracking blowup — it needs long lines),
// file size, and total wall-clock. They keep the result partial-but-flagged
// instead of hanging.
export const GREP_MAX_LINE = 2000;                 // chars — lines longer are skipped
export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB — bigger files are skipped
export const GREP_MAX_SCAN_MS = 4000;              // whole-scan wall-clock budget

/**
 * Search workspace files for a REGULAR-EXPRESSION query, line by line. `query` is a
 * JS regex (so `a|b` alternation works — the old literal `includes` matched the raw
 * string with the pipe and silently found nothing); an invalid pattern falls back to
 * a literal substring match. `root` may be a single FILE (grepped directly — the old
 * code `readdirSync`'d it and crashed with ENOTDIR) or a directory (recursed,
 * skipping `IGNORED_DIRS` + `*.map`). Caps at `max` hits (default 50) and is hardened
 * against pathological patterns (see GREP-HARDEN). When a guard forces partial
 * results, a final sentinel hit (`path: '(search truncated)'`) is appended so the
 * model knows the scan stopped early. Pure-ish (fs reads).
 */
export function grepSearch(
  query: string,
  root: string,
  wsRoot: string,
  max = 50,
  shouldScan: (repoRelativePath: string) => boolean = () => true,
): GrepHit[] {
  let matcher: (line: string) => boolean;
  try {
    const re = new RegExp(query);
    matcher = (line) => re.test(line);
  } catch {
    matcher = (line) => line.includes(query);
  }
  const results: GrepHit[] = [];
  const startedAt = Date.now();
  let truncatedReason = '';
  const overBudget = (): boolean => Date.now() - startedAt > GREP_MAX_SCAN_MS;

  const scanFile = (full: string): void => {
    try {
      if (!shouldScan(path.relative(wsRoot, full).replaceAll('\\', '/'))) return;
      // Per-file size guard — check before reading so a huge file never loads.
      if (fs.statSync(full).size > GREP_MAX_FILE_BYTES) { truncatedReason ||= 'skipped files over 2 MB'; return; }
      const content = fs.readFileSync(full, 'utf8');
      // Cheap binary sniff — a NUL byte in a "text" read means it isn't source.
      if (content.includes(String.fromCharCode(0))) return; // NUL byte => binary, not source
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (overBudget()) { truncatedReason = 'scan stopped at the 4 s time budget'; return; }
        const line = lines[i];
        // Per-LINE length guard — the key fix. A regex hit inside a 2000+ char line
        // is useless anyway, and skipping long lines removes the catastrophic
        // backtracking blowup (which only manifests on long inputs).
        if (line.length > GREP_MAX_LINE) { truncatedReason ||= 'skipped very long lines'; continue; }
        if (matcher(line)) {
          results.push({ path: path.relative(wsRoot, full), line: i + 1, text: line.trim() });
          if (results.length >= max) return;
        }
      }
    } catch {
      /* binary / unreadable — skip */
    }
  };
  const search = (dir: string): void => {
    if (results.length >= max || overBudget()) return;
    for (const file of fs.readdirSync(dir)) {
      if (IGNORED_DIRS.has(file)) continue;
      if (file.endsWith('.map')) continue; // source maps are one giant line — never useful, always slow
      const full = path.join(dir, file);
      if (!isPathInside(wsRoot, fs.realpathSync(full))) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) search(full);
      else if (stat.isFile()) { scanFile(full); if (results.length >= max) return; }
      if (overBudget()) { truncatedReason ||= 'scan stopped at the 4 s time budget'; return; }
    }
  };
  const rootStat = fs.existsSync(root) ? fs.statSync(root) : null;
  if (rootStat?.isFile()) scanFile(root);
  else if (rootStat?.isDirectory()) search(root);
  else throw new Error(`grep_search path not found: ${path.relative(wsRoot, root) || root}`);
  if (truncatedReason && results.length < max) {
    results.push({ path: '(search truncated)', line: 0, text: `grep_search returned PARTIAL results — ${truncatedReason}. Narrow the query or search a specific path.` });
  }
  return results;
}
