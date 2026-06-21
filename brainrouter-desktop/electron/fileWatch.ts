/**
 * FILES-LIVE — a debounced recursive workspace watcher for the desktop host.
 *
 * The Files / Changes panel used to refresh only on manual click, focus, or a
 * 5s git poll. This watches the workspace and fires a single coalesced callback
 * on real filesystem change (agent edits, terminal, git checkout, npm install),
 * so the panel stays live like a code editor's explorer.
 *
 * Pure `shouldIgnoreWatchPath` is exported for unit tests; the watcher itself is
 * best-effort and degrades to a noop where `fs.watch({recursive})` is
 * unsupported (Linux) — the existing git poll covers that case.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directory names whose churn should NOT trigger a panel refresh. */
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'dist-electron', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '.vite', '.brainrouter',
  '.idea', '.vscode-test', 'tmp', '.DS_Store',
]);

/** Editor/VCS temp + lock files that fire spurious events. */
const IGNORE_FILE = /(^|\/)(\.#|4913$)|(~|\.swp|\.swx|\.tmp|\.lock)$|(^|\/)\.DS_Store$/;

/**
 * True iff a watched RELATIVE path is noise that should not trigger a refresh.
 * Pure + separator-normalized so it's the same on macOS / Windows.
 */
export function shouldIgnoreWatchPath(rel: string | null | undefined): boolean {
  if (!rel) return false;
  const norm = rel.split(path.sep).join('/');
  if (norm.split('/').some((seg) => IGNORE_DIRS.has(seg))) return true;
  if (IGNORE_FILE.test(norm)) return true;
  return false;
}

/**
 * Start a debounced recursive watcher on `root`. Calls `onChange` at most once
 * per `debounceMs` after a burst of (non-ignored) events. Returns a close fn.
 * Never throws — returns a noop closer if the recursive watch can't start.
 */
export function startWorkspaceWatcher(
  root: string,
  onChange: () => void,
  debounceMs = 300,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; try { onChange(); } catch { /* swallow */ } }, debounceMs);
  };
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      const rel = typeof filename === 'string'
        ? filename
        : filename ? Buffer.from(filename as unknown as Uint8Array).toString('utf8') : '';
      // A null filename (macOS directory-level event) is a real change with no
      // path — don't drop it; only drop when we KNOW the path is ignored.
      if (rel && shouldIgnoreWatchPath(rel)) return;
      schedule();
    });
    return () => { if (timer) clearTimeout(timer); try { watcher.close(); } catch { /* noop */ } };
  } catch {
    // fs.watch recursive unsupported (Linux) — the 5s git poll remains the
    // fallback for the Changes list.
    return () => { if (timer) clearTimeout(timer); };
  }
}
