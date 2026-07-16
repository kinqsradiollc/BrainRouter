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
const ALLOWED_LAUNCHERS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'vite', 'deno', 'nx', 'turbo']);
export function isAllowedLauncher(exe: string): boolean {
  const base = path.basename(String(exe ?? '').trim().toLowerCase()).replace(/\.(cmd|exe|bat|ps1)$/, '');
  return ALLOWED_LAUNCHERS.has(base);
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
