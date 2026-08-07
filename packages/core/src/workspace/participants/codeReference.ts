/**
 * ADR-029 C2 row 6 — "a reference to a file/symbol that survives the file
 * moving". This module owns the two things that makes true: where a path went,
 * and where a name is declared.
 *
 * **Why a missing file is not one answer but four.** A3's rule is that a
 * reference is live, and the argument it makes for tombstones applies just as
 * hard one level down: collapsing "moved", "deleted" and "never existed" into a
 * single `never_existed` tells the reader their link was a typo when in fact
 * someone renamed a directory. That is the quietly-wrong outcome A3 exists to
 * prevent, and it is worse than saying nothing because it accuses the author.
 * So the outcomes are distinguished:
 *
 *   - the path exists                          -> `found`
 *   - git knows where it went                  -> `moved`, with the new path
 *   - git has history for it but no rename     -> `deleted` (it existed once)
 *   - git has no record of it at all           -> `never_existed`, and true
 *   - there is no git, or git cannot answer    -> `unknown`, which the caller
 *     reports as `unavailable` — the status resolution has precisely for "this
 *     surface cannot answer", rather than guessing at one of the other four.
 *
 * **Git is consulted narrowly and defensively.** Every call passes argv (never
 * a shell string), carries a short timeout because a resolve sits behind an
 * inline chip and a fifteen-second stall renders as a hung document, and caps
 * its output. A path arriving from a note is UNTRUSTED — it was typed by
 * whoever wrote the note, or pasted from content that synced in — so
 * containment is checked BEFORE any argv is built, and a path that escapes the
 * workspace is refused rather than handed to git with `-C` pointing at a root
 * it is outside of.
 *
 * **The git commands, and why these ones.** Pathspec limiting happens *before*
 * rename detection, so `git log --diff-filter=R -- <old path>` reports the
 * rename as a plain `D` and finds nothing — the naive query silently produces
 * the wrong answer. The working query is two steps: find the commit that
 * removed the path, then read THAT commit's name-status with rename detection
 * over the whole diff, where the `R old new` line exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPathInside, resolveWorkspacePath } from '../../agent/fs/workspaceFs.js';

/**
 * A resolve runs while someone waits for a chip to fill in, so git gets one
 * short breath rather than the 15s the workspace-identity helpers allow: those
 * run once at startup, this one runs per reference on screen.
 */
const GIT_TIMEOUT_MS = 2_500;

/** One commit's name-status is small; the cap exists so a pathological repo cannot make it large. */
const GIT_MAX_BUFFER = 1_000_000;

/** Bigger than any file a person cites a symbol in; a bundle is not source. */
export const MAX_SYMBOL_SCAN_BYTES = 2_000_000;

/** A minified bundle is one enormous line. Scanning it for declarations finds noise. */
const MAX_SYMBOL_LINE_LENGTH = 2_000;

/** Enough for a file's public surface; a picker showing more is a file listing. */
const MAX_SYMBOLS = 400;

export type CodeFileLocation =
  | { readonly status: 'found'; readonly path: string; readonly absolute: string }
  | {
      readonly status: 'moved';
      /** Where it is NOW, workspace-relative — what the reference resolves to. */
      readonly path: string;
      readonly absolute: string;
      /** Where the reference pointed. Kept so the label can say it moved. */
      readonly from: string;
      readonly at?: string;
    }
  | { readonly status: 'deleted'; readonly at?: string }
  | { readonly status: 'never_existed' }
  /** The path escapes the workspace root; nothing was executed. */
  | { readonly status: 'refused'; readonly detail: string }
  /** No git, git failed, or it went somewhere this workspace cannot address. */
  | { readonly status: 'unknown'; readonly detail: string };

/* ------------------------------------------------------------------- git */

interface GitOutput {
  readonly ok: boolean;
  readonly stdout: string;
}

const GIT_FAILED: GitOutput = { ok: false, stdout: '' };

/**
 * One git invocation, bounded on every axis that can hang or grow.
 *
 * `shell` is left off (spawnSync's default) so the arguments are passed as
 * argv: a path is data here, and a path containing `;` or `$(…)` must be a path
 * git cannot find rather than a command.
 */
function git(cwd: string, args: readonly string[]): GitOutput {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `error` covers the two failures that are not a non-zero status: git is
    // not installed, and the timeout fired.
    if (result.error || result.status !== 0) return GIT_FAILED;
    return { ok: true, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  } catch {
    return GIT_FAILED;
  }
}

function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The owning repository root, or null when this workspace is not in one. */
function gitRootOf(workspaceRoot: string): string | null {
  const out = git(workspaceRoot, ['rev-parse', '--show-toplevel']);
  if (!out.ok) return null;
  const root = out.stdout.trim();
  return root ? realpath(root) : null;
}

/** Git speaks in forward slashes relative to the repository root, on every platform. */
function toRepoPath(gitRoot: string, absolute: string): string | null {
  const relative = path.relative(gitRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** `R100\told\tnew` — the only line shape that says where something went. */
function renameTarget(nameStatus: string, from: string): string | null {
  for (const line of nameStatus.split('\n')) {
    if (line.charCodeAt(0) !== 82 /* R */) continue;
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[1] === from) return parts[2] ?? null;
  }
  return null;
}

/** What git can say about a path, in git's own vocabulary: repository-relative. */
type GitTrace =
  | { readonly status: 'moved'; readonly to: string; readonly at?: string }
  | { readonly status: 'deleted'; readonly at?: string }
  | { readonly status: 'never_existed' }
  | { readonly status: 'unknown'; readonly detail: string };

/**
 * Where the repository thinks this path went, newest evidence first.
 *
 * The index is consulted before history because a `git mv` five minutes ago is
 * more current than any commit, and a reference that only starts following the
 * move once someone commits would be wrong for exactly as long as the branch is
 * unfinished — which is when notes are being written.
 */
function traceInGit(gitRoot: string, repoPath: string): GitTrace {
  const staged = git(gitRoot, ['diff', '--cached', '--name-status', '--find-renames', '--']);
  if (staged.ok) {
    const movedTo = renameTarget(staged.stdout, repoPath);
    if (movedTo) return { status: 'moved', to: movedTo };
  }

  // The commit that removed the path. `--diff-filter=D` on a pathspec is
  // reliable in a way `--diff-filter=R` is not: git filters by pathspec before
  // detecting renames, so a rename looks like a delete from here — which is
  // exactly what makes it findable, and why the rename is read from the commit
  // rather than from this query.
  const removal = git(gitRoot, [
    'log', '-n', '1', '--diff-filter=D', '--format=%H%x1f%cI', '--', repoPath,
  ]);
  if (!removal.ok) return { status: 'unknown', detail: 'git could not read this repository' };

  const [sha, at] = removal.stdout.trim().split('\x1f');
  if (sha) {
    const commit = git(gitRoot, ['show', '--name-status', '--find-renames', '--format=', sha]);
    const movedTo = commit.ok ? renameTarget(commit.stdout, repoPath) : null;
    if (movedTo) return at ? { status: 'moved', to: movedTo, at } : { status: 'moved', to: movedTo };
    return at ? { status: 'deleted', at } : { status: 'deleted' };
  }

  // No commit removed it. Either it is in HEAD and someone deleted it in the
  // working tree — which is still "it existed" — or git has never heard of it.
  const anyHistory = git(gitRoot, ['log', '-n', '1', '--format=%cI', '--', repoPath]);
  if (!anyHistory.ok) return { status: 'unknown', detail: 'git could not read this repository' };
  return anyHistory.stdout.trim() ? { status: 'deleted' } : { status: 'never_existed' };
}

/* -------------------------------------------------------------- locating */

/**
 * Where the reference points now.
 *
 * Containment is the first thing that happens and it happens before any argv is
 * assembled, so a note saying `../../../etc/passwd` is refused by this process
 * rather than by git's inability to find it.
 */
export function locateCodeFile(workspaceRoot: string, relPath: string): CodeFileLocation {
  let absolute: string;
  try {
    absolute = resolveWorkspacePath(workspaceRoot, relPath);
  } catch (err) {
    return { status: 'refused', detail: err instanceof Error ? err.message : String(err) };
  }

  if (fs.existsSync(absolute)) return { status: 'found', path: relPath, absolute };

  const gitRoot = gitRootOf(workspaceRoot);
  if (!gitRoot) {
    return { status: 'unknown', detail: 'this workspace has no git history to follow the file through' };
  }
  const repoPath = toRepoPath(gitRoot, absolute);
  if (!repoPath) return { status: 'unknown', detail: 'the path is outside the repository' };

  const traced = traceInGit(gitRoot, repoPath);
  if (traced.status !== 'moved') return traced;

  // Git answers in repository terms and a reference is written in workspace
  // terms. When the workspace is a subdirectory, a file can move somewhere the
  // reference cannot address — which is a thing this surface cannot answer
  // rather than a deletion.
  const movedAbsolute = path.resolve(gitRoot, traced.to);
  const root = realpath(workspaceRoot);
  if (!isPathInside(root, movedAbsolute)) {
    return { status: 'unknown', detail: `it moved to ${traced.to}, outside this workspace` };
  }
  if (!fs.existsSync(movedAbsolute)) {
    // Git's record and the disk disagree: the rename is recorded and the new
    // path is not there either. Reporting `moved` would send the reader to a
    // second missing file.
    return traced.at ? { status: 'deleted', at: traced.at } : { status: 'deleted' };
  }
  const workspacePath = path.relative(root, movedAbsolute).split(path.sep).join('/');
  return traced.at
    ? { status: 'moved', path: workspacePath, absolute: movedAbsolute, from: relPath, at: traced.at }
    : { status: 'moved', path: workspacePath, absolute: movedAbsolute, from: relPath };
}

/* --------------------------------------------------------------- symbols */

export interface CodeSymbol {
  readonly name: string;
  /** 1-based, so it reads the way an editor's gutter does. */
  readonly line: number;
  /** The keyword that declared it — `function`, `class`, `def`, or `member`. */
  readonly kind: string;
}

/**
 * The words that introduce a name, across the languages this repository and
 * the projects it is pointed at are written in. Deliberately a keyword list
 * rather than a parser: a parser per language is a dependency and a per-language
 * failure mode, and this only has to find a line to point at.
 */
const DECLARATION_KEYWORDS = new Set([
  'function', 'class', 'interface', 'type', 'enum', 'namespace', 'module',
  'const', 'let', 'var', 'def', 'fn', 'func', 'struct', 'trait', 'impl', 'record', 'val',
]);

/** Words that decorate a declaration without being one. Skipped, never matched. */
const DECLARATION_MODIFIERS = new Set([
  'export', 'default', 'public', 'private', 'protected', 'internal', 'static',
  'async', 'readonly', 'abstract', 'override', 'final', 'declare', 'pub', 'inline', 'extern',
]);

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

/**
 * The URI grammar's own fragment cap. Held here as well so a name that cannot
 * be ADDRESSED is never offered as one: the picker would produce a URI the
 * parser rejects, and the link would quietly fail to be written.
 */
const MAX_SYMBOL_NAME_LENGTH = 64;

/** A symbol addressable in a reference. Validated rather than escaped, so no metacharacter survives. */
export function isCodeSymbolName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SYMBOL_NAME_LENGTH) return false;
  if (!isNameStart(value[0]!)) return false;
  for (const ch of value) if (!isNameChar(ch)) return false;
  return true;
}

/** Read one identifier starting at `from`, or null if there is not one there. */
function readName(line: string, from: number): { name: string; end: number } | null {
  if (from >= line.length || !isNameStart(line[from]!)) return null;
  let end = from;
  while (end < line.length && isNameChar(line[end]!)) end += 1;
  return { name: line.slice(from, end), end };
}

function skipSpace(line: string, from: number): number {
  let i = from;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '*')) i += 1;
  return i;
}

/**
 * The declaration this line makes, or null.
 *
 * Scanned character by character rather than with a regex per keyword. Two
 * reasons, and the second is the load-bearing one: the input is a line of a
 * file a note pointed at, so its length is not ours to assume, and an
 * unanchored pattern over attacker-length input is the quadratic backtracking
 * this codebase has already had to remove once.
 *
 * ONE implementation, used by both listing and lookup — otherwise the picker
 * offers symbols the resolver cannot find, which reads as the reference being
 * broken the moment it is written.
 */
export function declarationOnLine(line: string): { name: string; kind: string } | null {
  if (line.length === 0 || line.length > MAX_SYMBOL_LINE_LENGTH) return null;

  let i = skipSpace(line, 0);
  // Modifiers first: `export default async function name` is four words before
  // the one that matters, and stopping at the first is how `export` becomes the
  // declaration keyword.
  let word = readName(line, i);
  while (word && DECLARATION_MODIFIERS.has(word.name)) {
    i = skipSpace(line, word.end);
    word = readName(line, i);
  }
  if (!word) return null;

  if (DECLARATION_KEYWORDS.has(word.name)) {
    const nameStart = skipSpace(line, word.end);
    const named = readName(line, nameStart);
    // `const [a, b] = …` destructures; there is no single name to address.
    if (!named) return null;
    return { name: named.name, kind: word.name };
  }

  // A member: `parse(input) {`, `parse: (input) => …`, `parse = async () => {`.
  // Required to be the first thing on the line, because anything with a word in
  // front of it is a call — `return parse(input)` — and treating a call site as
  // a declaration would point the reference at the wrong line.
  const after = skipSpace(line, word.end);
  const next = line[after];
  const trimmed = line.trimEnd();
  if (next === '(' && trimmed.endsWith('{')) return { name: word.name, kind: 'member' };
  if ((next === ':' || next === '=') && (line.includes('=>') || line.includes('function'))) {
    return { name: word.name, kind: 'member' };
  }
  return null;
}

/**
 * Every symbol this file declares, first declaration wins.
 *
 * First rather than last because a reference addresses the definition, and a
 * later line mentioning the same name is an overload or a re-export.
 */
export function listCodeSymbols(source: string): CodeSymbol[] {
  const seen = new Set<string>();
  const symbols: CodeSymbol[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i += 1) {
    const found = declarationOnLine(lines[i]!);
    // A name that cannot be addressed is not offered: the picker's whole point
    // is that every row it shows produces a reference that resolves.
    if (!found || seen.has(found.name) || !isCodeSymbolName(found.name)) continue;
    seen.add(found.name);
    symbols.push({ name: found.name, line: i + 1, kind: found.kind });
  }
  return symbols;
}

export function findCodeSymbol(source: string, name: string): CodeSymbol | null {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const found = declarationOnLine(lines[i]!);
    if (found?.name === name) return { name, line: i + 1, kind: found.kind };
  }
  return null;
}

export type CodeSymbolHistory =
  | { readonly status: 'deleted'; readonly at?: string }
  | { readonly status: 'never_existed' }
  | { readonly status: 'unknown'; readonly detail: string };

/**
 * Did this name ever live in this file?
 *
 * The file is here and the symbol is not, which on its own cannot distinguish
 * "it was renamed last week" from "you mistyped it" — and those lead to
 * different actions, so the pickaxe is worth one subprocess. `-S` reports the
 * commits that changed how many times the string occurs in that path, which for
 * a name that is now absent is the commit that removed it.
 */
export function traceRemovedSymbol(workspaceRoot: string, relPath: string, name: string): CodeSymbolHistory {
  if (!isCodeSymbolName(name)) return { status: 'unknown', detail: 'not an addressable symbol name' };
  let absolute: string;
  try {
    absolute = resolveWorkspacePath(workspaceRoot, relPath);
  } catch {
    return { status: 'unknown', detail: 'the path is outside this workspace' };
  }
  const gitRoot = gitRootOf(workspaceRoot);
  if (!gitRoot) return { status: 'unknown', detail: 'this workspace has no git history' };
  const repoPath = toRepoPath(gitRoot, absolute);
  if (!repoPath) return { status: 'unknown', detail: 'the path is outside the repository' };

  const out = git(gitRoot, ['log', '-n', '1', '--format=%cI', `-S${name}`, '--', repoPath]);
  if (!out.ok) return { status: 'unknown', detail: 'git could not read this repository' };
  const at = out.stdout.trim().split('\n')[0]?.trim();
  if (!at) return { status: 'never_existed' };
  return { status: 'deleted', at };
}

/** Read a file for symbol scanning, or say why it was not read. */
export function readSourceForSymbols(absolute: string): { ok: true; source: string } | { ok: false; reason: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (stat.isDirectory()) return { ok: false, reason: 'a directory declares no symbols' };
  if (stat.size > MAX_SYMBOL_SCAN_BYTES) return { ok: false, reason: 'the file is too large to scan for a symbol' };
  try {
    return { ok: true, source: fs.readFileSync(absolute, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
