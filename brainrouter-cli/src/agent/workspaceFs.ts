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
export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.DS_Store', '.next']);

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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

  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('Path must be a non-empty string.');
  }

  const root = fs.realpathSync(workspaceRoot);
  const resolved = path.resolve(root, inputPath);
  const checkPath = options.forWrite ? path.dirname(resolved) : resolved;
  const existingCheckPath = fs.existsSync(checkPath) ? fs.realpathSync(checkPath) : checkPath;

  if (!isPathInside(root, existingCheckPath) || !isPathInside(root, resolved)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }

  return resolved;
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
