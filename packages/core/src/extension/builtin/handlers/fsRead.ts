// ADR-041 D8 — the read-only filesystem tools. list_dir / grep_search / glob_files
// read the workspace through the D3 filesystem port + the shared resolveHere scope
// binding (both from BuiltinToolContext), gated by the reviewer-path safety guards
// (now in review/sourceSafety.ts, shared with read_file/edit_file). No writes, no
// approval, no lease. Bodies are the former case bodies verbatim.

import fs from 'node:fs';
import path from 'node:path';
import { assertSafeReviewerFilesystemPath, isSafeReviewerFilesystemPath, redactReviewSourceText } from '../../../review/sourceSafety.js';
import { grepSearch, globFiles } from '../../../agent/fs/workspaceFs.js';
import type { BuiltinToolHandler } from './registry.js';

export const fsReadHandlers: Record<string, BuiltinToolHandler> = {
  list_dir: async ({ args, host, resolveHere, fsPort }) => {
    const targetDir = resolveHere(args.path || '.');
    if (!(await fsPort.exists(targetDir)) || !(await fsPort.stat(targetDir)).isDirectory) {
      throw new Error(`Directory not found: ${args.path || '.'}`);
    }
    if (host.reviewSourceSafety) {
      assertSafeReviewerFilesystemPath(host.workspaceRoot, targetDir, args.path || '.');
    }
    const items = await fsPort.readDir(targetDir);
    const list = (await Promise.all(items.map(async (item) => {
      const full = path.join(targetDir, item);
      if (host.reviewSourceSafety && !isSafeReviewerFilesystemPath(host.workspaceRoot, full)) {
        return null;
      }
      const stat = await fsPort.stat(full);
      return {
        name: item,
        type: stat.isDirectory ? 'directory' : 'file',
        size: stat.isFile ? stat.size : undefined,
      };
    }))).filter((e): e is NonNullable<typeof e> => e !== null);
    return JSON.stringify(list, null, 2);
  },

  grep_search: async ({ args, host, resolveHere }) => {
    const wsRoot = fs.realpathSync(host.workspaceRoot);
    const root = resolveHere(args.path || '.');
    if (host.reviewSourceSafety) {
      assertSafeReviewerFilesystemPath(wsRoot, root, args.path || '.');
    }
    const query = String(args.query ?? '');
    if (!query) throw new Error('Missing parameter "query" for grep_search.');
    // grepSearch: regex match (not literal `includes`) + accepts a file OR a
    // directory (the old inline version crashed with ENOTDIR on a file path).
    const hits = grepSearch(
      query,
      root,
      wsRoot,
      50,
      host.reviewSourceSafety
        ? (candidate) => isSafeReviewerFilesystemPath(wsRoot, path.resolve(wsRoot, candidate))
        : undefined,
    );
    return host.reviewSourceSafety
      ? redactReviewSourceText(JSON.stringify(hits, null, 2))
      : JSON.stringify(hits, null, 2);
  },

  glob_files: async ({ args, host }) => {
    const pattern = args.pattern;
    if (!pattern) {
      throw new Error('Missing parameter "pattern" for glob_files.');
    }
    const reviewRoot = host.reviewSourceSafety ? fs.realpathSync(host.workspaceRoot) : host.workspaceRoot;
    const matches = globFiles(pattern, host.workspaceRoot).filter((candidate) => (
      !host.reviewSourceSafety
      || isSafeReviewerFilesystemPath(reviewRoot, path.resolve(reviewRoot, candidate))
    ));
    return JSON.stringify(matches, null, 2);
  },
};
