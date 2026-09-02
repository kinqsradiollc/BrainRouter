/**
 * Pure path/name guards for the Browser host. The host is reachable over IPC by
 * the agent, so file names and extract paths it receives are UNTRUSTED — these
 * helpers keep every write/read contained to the workspace. Dependency-free
 * (only node:path) so they unit-test without electron.
 */
import path from 'node:path';

/**
 * A filesystem-safe basename for an agent-supplied flow/story/screenshot name:
 * strip any directory components (`path.basename` defeats `../` traversal and
 * absolute paths), collapse everything but `[a-z0-9_-]` to `-`, trim, and cap
 * length. Always returns a non-empty, single-segment token.
 */
export function safeName(name: string, fallback = 'flow'): string {
  const base = path.basename(String(name ?? '').trim() || fallback);
  return base.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback;
}

/**
 * True when `rel` (resolved against `root`) stays inside `root` — i.e. it's not
 * a `../` escape or an absolute path pointing elsewhere. Use before reading a
 * caller-supplied path so `extract({ only: ['../../etc/passwd'] })` can't read
 * outside the workspace.
 */
export function isPathWithinRoot(root: string, rel: string): boolean {
  const base = path.resolve(root);
  const full = path.resolve(base, String(rel ?? ''));
  return full === base || full.startsWith(base + path.sep);
}

/**
 * Auto-host spawns a dev server from `.claude/launch.json`, which a cloned repo
 * controls. Restrict the launcher to known dev-server runners so a config can't
 * name an arbitrary executable (CWE-78). `.cmd`/`.exe` suffixes are stripped.
 */
// Package script runners + specific local task-runner BINARIES only. Deliberately
// excluded: (a) the code-eval runtimes node/deno/bun (`node -e '<code>'`); (b) `npx`,
// which fetches + runs an ARBITRARY package (`npx <evil-pkg>` is RCE with no flag) —
// bare local tool binaries (vite/nx/turbo) resolve via the node_modules/.bin PATH the
// registry adds at spawn, so npx is not needed. An agent-added config therefore cannot
// reach a code-execution primitive (CWE-78/CWE-94).
const ALLOWED_LAUNCHERS = new Set(['npm', 'pnpm', 'yarn', 'vite', 'nx', 'turbo']);
export function isAllowedLauncher(exe: string): boolean {
  const base = path.basename(String(exe ?? '').trim().toLowerCase()).replace(/\.(cmd|exe|bat|ps1)$/, '');
  return ALLOWED_LAUNCHERS.has(base);
}

/**
 * True when an arg is an inline code-execution flag (`node -e`, `-p`, `-r`, `npx -c`,
 * …). These execute attacker-supplied code WITHOUT any shell metacharacter, so they
 * must be rejected in addition to hasShellMeta. Covers the short/long/`=` forms.
 */
const DANGEROUS_FLAG = /^--?(e|eval|p|print|c|call|r|require)(=|$)/i;
export function hasDangerousFlag(arg: string): boolean {
  return DANGEROUS_FLAG.test(String(arg ?? '').trim());
}

// Package-manager subcommands that run an ARBITRARY package/command rather than a
// project script — `npm exec`/`npm x`, `pnpm exec`/`dlx`, `yarn exec`/`dlx`, and the
// scaffolders `create`/`init` (which download + run a generator). These are code
// execution without a flag, so they must be rejected for the npm/pnpm/yarn launchers.
const EXEC_SUBCOMMANDS = new Set(['exec', 'x', 'dlx', 'create', 'init', 'add', 'install', 'i']);
export function hasExecSubcommand(exe: string, args: string[]): boolean {
  const base = path.basename(String(exe ?? '').trim().toLowerCase()).replace(/\.(cmd|exe|bat|ps1)$/, '');
  if (!['npm', 'pnpm', 'yarn'].includes(base)) return false;
  const sub = (Array.isArray(args) ? args : []).map(String).find((a) => a && !a.startsWith('-'));
  return sub != null && EXEC_SUBCOMMANDS.has(sub.toLowerCase());
}

/**
 * True when an arg carries a shell metacharacter. Auto-host spawns with
 * `shell:true` on Windows (needed for `.cmd`), so a config arg like `&& calc`
 * would inject — reject those. Legit dev args (`run`, `dev`, `--port`, paths)
 * have none of these.
 */
const SHELL_META = /[&|;$<>`(){}\n\r]/;
export function hasShellMeta(arg: string): boolean {
  return SHELL_META.test(String(arg ?? ''));
}

/**
 * Make an agent-supplied string safe to embed inline in a markdown run report:
 * collapse newlines (so it can't break the intended line/heading) and HTML-encode
 * `& < > " '` so an injected `<script>`/tag can't execute if the report is
 * rendered in a webview. Capped to keep reports readable.
 */
export function mdSafe(s: unknown): string {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .slice(0, 500);
}

/**
 * ADR-055 P8 (D4) — where an AGENT-initiated browser download lands: a
 * workspace inbox under `.brainrouter/browser/downloads/` (already gitignored),
 * so the agent's workspace-jailed file tools can read what it just downloaded.
 * Human downloads keep the OS Downloads folder.
 */
export function agentDownloadDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'browser', 'downloads');
}

/**
 * The POSIX workspace-relative path for a saved download, or null when it is not
 * inside the workspace (e.g. a human download in the OS folder). Lets the agent
 * `read_file` an in-workspace download by a relative path.
 */
export function workspaceRelativeDownloadPath(savePath: string, workspaceRoot: string): string | null {
  if (!savePath || !workspaceRoot) return null;
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(savePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * ADR-055 P2 (fix) — is the element under a coordinate click a CREDENTIAL FIELD
 * the agent must not target? A credential field is a value-bearing FORM CONTROL
 * (input/textarea/select) whose type/autocomplete/identity marks it sensitive.
 * An ordinary button/link/div is NEVER one, even if its id or aria-label merely
 * contains a word like "session" or "token" — that over-refusal was the bug.
 * This mirrors the in-page `isSensitive` in browserViewManager's pointHitScript
 * (kept in lockstep) and the snapshot's `valueIsSensitive`, which likewise only
 * applies to form inputs. `identity` is the lowercased join of id + name +
 * aria-label.
 */
export function isCredentialField(descriptor: { tag: string; type?: string; autocomplete?: string; identity?: string }): boolean {
  const tag = String(descriptor.tag || '').toUpperCase();
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return false;
  const type = String(descriptor.type || '').toLowerCase();
  if (['password', 'hidden'].includes(type)) return true;
  const autocomplete = String(descriptor.autocomplete || '').toLowerCase();
  if (/(?:current|new)-password|cc-(?:number|csc|exp)|one-time-code/.test(autocomplete)) return true;
  const identity = String(descriptor.identity || '').toLowerCase();
  return /(?:^|[^a-z])(password|passwd|secret|token|csrf|xsrf|session|authorization|api.?key|card.?number|credit.?card|cvv|cvc|csc|otp)(?:[^a-z]|$)/.test(identity);
}

/**
 * ADR-055 P10 — where "Save as PDF" writes: a workspace folder under the
 * already-gitignored `.brainrouter/`, so a print is reachable by the workspace
 * file tools and never lands somewhere surprising.
 */
export function browserPrintDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'browser', 'prints');
}
