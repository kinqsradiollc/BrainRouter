// ADR-041 D8 — the read-only filesystem tools. list_dir / grep_search / glob_files
// read the workspace through the D3 filesystem port + the shared resolveHere scope
// binding (both from BuiltinToolContext), gated by the reviewer-path safety guards
// (now in review/sourceSafety.ts, shared with read_file/edit_file). No writes, no
// approval, no lease. Bodies are the former case bodies verbatim.

import fs from 'node:fs';
import path from 'node:path';
import { assertSafeReviewerFilesystemPath, isSafeReviewerFilesystemPath, redactReviewSourceText } from '../../../review/sourceSafety.js';
import { truncateFullRead } from '../../../agent/fs/readTruncation.js';
import { grepSearch, globFiles } from '../../../agent/fs/workspaceFs.js';
import type { BuiltinToolHandler } from './registry.js';

export const fsReadHandlers: Record<string, BuiltinToolHandler> = {
  read_file: async ({ args, host, resolveHere, fsPort }) => {
    const resolved = resolveHere(args.path);
    if (!(await fsPort.exists(resolved))) {
      throw new Error(`File not found: ${args.path}`);
    }
    if (host.reviewSourceSafety) {
      assertSafeReviewerFilesystemPath(host.workspaceRoot, resolved, args.path);
    }
    // Bound the bytes pulled into memory. Previously this read the WHOLE file
    // (truncation only trimmed the RETURNED string), so a multi-GB file would
    // be fully buffered before any cap applied. Read at most READ_FILE_MAX_BYTES;
    // the full-read path truncates the visible output further via truncateFullRead.
    const READ_FILE_MAX_BYTES = 16 * 1024 * 1024;
    const { content } = await fsPort.readFileBounded(resolved, READ_FILE_MAX_BYTES);
    host.filesReadThisSession.add(resolved); // CC-P6.4 — read-before-edit ledger
    // CLI-REINDEX — keep the code index fresh on read; fire-and-forget so
    // reads stay snappy, and guarded so a rejection never escapes.
    if (!host.reviewSourceSafety) {
      void host.maybeReindexSource(resolved, content).catch(() => {});
    }
    const visibleContent = host.reviewSourceSafety ? redactReviewSourceText(content) : content;
    const startLine = args.startLine ? Number(args.startLine) : 1;
    const endLine = args.endLine ? Number(args.endLine) : undefined;

    if (startLine === 1 && endLine === undefined) {
      // CC-P7.3 — cap an unbounded full-file read so a huge file can't blow
      // the context window; the model gets an explicit reread affordance.
      return truncateFullRead(visibleContent, String(args.path)).text;
    }

    const lines = visibleContent.split('\n');
    const endIdx = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;
    const startIdx = Math.max(1, Math.min(startLine, lines.length));

    if (startIdx > endIdx) {
      return '';
    }

    return lines.slice(startIdx - 1, endIdx).join('\n');
  },

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
