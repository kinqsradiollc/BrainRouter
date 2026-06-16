import fs from 'node:fs';
import path from 'node:path';

/**
 * DESK-6w (T9) — directory-aware workspace file reads.
 *
 * `fs.readFileSync` on a directory throws `EISDIR`, which used to surface as a
 * raw error in the file viewer / chat. These helpers stat the path first and
 * return a typed payload, and provide a guard so the single-file diff viewer
 * doesn't attempt a diff on a folder. Pure (fs only) so they're unit-testable.
 */
export interface WorkspaceEntry {
  path: string;
  kind: 'file' | 'directory';
  /** file text, or a newline-joined listing when `kind === 'directory'`. */
  content: string;
  /** present when `kind === 'directory'`. */
  entries?: Array<{ name: string; dir: boolean }>;
  truncated?: boolean;
  error?: string;
}

const MAX_BYTES = 200_000;

function insideWorkspace(workspaceRoot: string, relPath: string): { ok: boolean; resolved: string } {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relPath);
  const ok = resolved === root || resolved.startsWith(root + path.sep);
  return { ok, resolved };
}

/** Read a workspace-relative path. Directories return a typed listing (never EISDIR). */
export function readWorkspaceEntry(workspaceRoot: string, relPath: string): WorkspaceEntry {
  if (!relPath) return { path: relPath, kind: 'file', content: '', error: 'no path' };
  const { ok, resolved } = insideWorkspace(workspaceRoot, relPath);
  if (!ok) return { path: relPath, kind: 'file', content: '', error: 'path escapes the workspace' };
  try {
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        .slice(0, 1000);
      return {
        path: relPath, kind: 'directory', entries,
        content: entries.map((e) => (e.dir ? `${e.name}/` : e.name)).join('\n'),
      };
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    return { path: relPath, kind: 'file', content: content.slice(0, MAX_BYTES), truncated: content.length > MAX_BYTES };
  } catch (err) {
    return { path: relPath, kind: 'file', content: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** True when a workspace-relative path is an existing directory (diff guard). */
export function isWorkspaceDirectory(workspaceRoot: string, relPath: string): boolean {
  if (!relPath) return false;
  const { ok, resolved } = insideWorkspace(workspaceRoot, relPath);
  if (!ok) return false;
  try { return fs.statSync(resolved).isDirectory(); } catch { return false; }
}
