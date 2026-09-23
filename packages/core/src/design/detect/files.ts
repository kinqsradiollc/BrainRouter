/**
 * Workspace file collection for the detector (ADR-056 D-B1).
 *
 * The engine takes content; this is the one place that touches disk. Every
 * requested path is resolved under the workspace root and refused when it
 * escapes it; directories are walked with the usual exclusions (node_modules,
 * dist, .git, build output) and bounded by count and size, so a request for
 * "the whole repo" costs a known amount and cannot be steered outside the
 * workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DesignInputFile } from './engine.js';

export const DESIGN_FILE_LIMITS = { maxFiles: 200, maxBytes: 512 * 1024, maxDepth: 12 } as const;

const UI_EXT = /\.(html?|xhtml|svelte|vue|jsx|tsx|astro|mdx|css|scss|less)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'out', '.git', '.next', '.turbo', 'coverage', '.brainrouter', 'vendor']);

export interface CollectResult {
  files: DesignInputFile[];
  /** Requested paths that were outside the workspace, missing, or over the limits. */
  refused: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

/** Collect UI files for the given workspace-relative paths (files or directories; default: the workspace root). */
export function collectDesignFiles(workspaceRoot: string, requested: string[] = ['.']): CollectResult {
  const root = path.resolve(workspaceRoot);
  const files: DesignInputFile[] = [];
  const refused: CollectResult['refused'] = [];
  let truncated = false;
  const seen = new Set<string>();

  const add = (abs: string): void => {
    if (files.length >= DESIGN_FILE_LIMITS.maxFiles) { truncated = true; return; }
    if (seen.has(abs)) return;
    seen.add(abs);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { refused.push({ path: path.relative(root, abs), reason: 'missing' }); return; }
    if (st.size > DESIGN_FILE_LIMITS.maxBytes) { refused.push({ path: path.relative(root, abs), reason: `over ${DESIGN_FILE_LIMITS.maxBytes} bytes` }); return; }
    try { files.push({ path: path.relative(root, abs).split(path.sep).join('/'), content: fs.readFileSync(abs, 'utf8') }); } catch { refused.push({ path: path.relative(root, abs), reason: 'unreadable' }); }
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > DESIGN_FILE_LIMITS.maxDepth || files.length >= DESIGN_FILE_LIMITS.maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); }
      else if (e.isFile() && UI_EXT.test(e.name)) add(path.join(dir, e.name));
      if (files.length >= DESIGN_FILE_LIMITS.maxFiles) { truncated = true; return; }
    }
  };
  for (const req of requested.length ? requested : ['.']) {
    const abs = path.resolve(root, req);
    if (abs !== root && !abs.startsWith(root + path.sep)) { refused.push({ path: req, reason: 'outside the workspace' }); continue; }
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { refused.push({ path: req, reason: 'missing' }); continue; }
    if (st.isDirectory()) walk(abs, 0);
    else if (UI_EXT.test(abs)) add(abs);
    else refused.push({ path: req, reason: 'not a UI file (html, css, jsx/tsx, svelte, vue, astro)' });
  }
  return { files, refused, truncated };
}
