import fs from 'node:fs';
import path from 'node:path';
const MAX_BYTES = 200_000;
const DEFAULT_FILE_LIST_LIMIT = 3000;
const FILE_LIST_IGNORED_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    '.next',
    '.turbo',
    'coverage',
    'dist',
    'node_modules',
    'out',
]);
export function enableLiteralAsarWorkspacePaths() {
    process.noAsar = true;
}
enableLiteralAsarWorkspacePaths();
function isAsarPathName(name) {
    return name.toLowerCase().endsWith('.asar');
}
function insideWorkspace(workspaceRoot, relPath) {
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, relPath);
    const ok = resolved === root || resolved.startsWith(root + path.sep);
    return { ok, resolved };
}
/** Bounded workspace file list for non-git projects or repos where git returns
 * no files. Avoids heavyweight dependency/index folders and never follows
 * symlinked directories. */
export function listWorkspaceFiles(workspaceRoot, opts) {
    const limit = Math.max(1, Math.min(10_000, Math.floor(opts?.limit ?? DEFAULT_FILE_LIST_LIMIT)));
    const maxDepth = Math.max(1, Math.min(12, Math.floor(opts?.maxDepth ?? 8)));
    const root = path.resolve(workspaceRoot);
    const files = [];
    let truncated = false;
    const queue = [{ abs: root, rel: '', depth: 0 }];
    try {
        while (queue.length && files.length < limit) {
            const current = queue.shift();
            let entries;
            try {
                entries = fs.readdirSync(current.abs, { withFileTypes: true });
            }
            catch {
                continue;
            }
            entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
            for (const entry of entries) {
                if (entry.name === '.DS_Store')
                    continue;
                const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    if (current.depth >= maxDepth || FILE_LIST_IGNORED_DIRS.has(entry.name.toLowerCase()) || isAsarPathName(entry.name))
                        continue;
                    queue.push({ abs: path.join(current.abs, entry.name), rel, depth: current.depth + 1 });
                    continue;
                }
                if (entry.isSymbolicLink())
                    continue;
                if (!entry.isFile())
                    continue;
                files.push(rel);
                if (files.length >= limit) {
                    truncated = true;
                    break;
                }
            }
        }
        if (queue.length > 0)
            truncated = true;
        return { files, truncated, source: 'filesystem' };
    }
    catch (err) {
        return { files: [], truncated: false, source: 'filesystem', error: err instanceof Error ? err.message : String(err) };
    }
}
/** Read a workspace-relative path. Directories return a typed listing (never EISDIR). */
export function readWorkspaceEntry(workspaceRoot, relPath) {
    if (!relPath)
        return { path: relPath, kind: 'file', content: '', error: 'no path' };
    const { ok, resolved } = insideWorkspace(workspaceRoot, relPath);
    if (!ok)
        return { path: relPath, kind: 'file', content: '', error: 'path escapes the workspace' };
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
        const buf = fs.readFileSync(resolved);
        // Binary detection: a NUL byte in the first 8KB is the cheap, reliable signal
        // editors use. Binary files come back flagged with empty content (the panel
        // shows a preview card / open-externally instead of mounting the editor).
        if (buf.subarray(0, 8192).includes(0)) {
            return { path: relPath, kind: 'file', content: '', binary: true, size: buf.length, mtimeMs: st.mtimeMs };
        }
        const content = buf.toString('utf-8');
        return { path: relPath, kind: 'file', content: content.slice(0, MAX_BYTES), truncated: buf.length > MAX_BYTES, size: buf.length, mtimeMs: st.mtimeMs };
    }
    catch (err) {
        return { path: relPath, kind: 'file', content: '', error: err instanceof Error ? err.message : String(err) };
    }
}
/** Cheap stat probe for a workspace-relative path. Never throws; returns
 *  `{exists:false}` for a missing path and the same escape guard as reads. */
export function statWorkspaceEntry(workspaceRoot, relPath) {
    if (!relPath)
        return { path: relPath, exists: false, error: 'no path' };
    const { ok, resolved } = insideWorkspace(workspaceRoot, relPath);
    if (!ok)
        return { path: relPath, exists: false, error: 'path escapes the workspace' };
    try {
        const st = fs.statSync(resolved);
        return { path: relPath, exists: true, kind: st.isDirectory() ? 'directory' : 'file', mtimeMs: st.mtimeMs, size: st.size };
    }
    catch (err) {
        const e = err;
        if (e.code === 'ENOENT')
            return { path: relPath, exists: false };
        return { path: relPath, exists: false, error: e.message };
    }
}
/**
 * Write a workspace-relative file with three guards, in order:
 *  1. logical containment — `relPath` must resolve inside `workspaceRoot`;
 *  2. symlink-escape — the real parent dir (and the file, if a symlink) must
 *     also resolve inside the root, so a symlinked dir/file can't redirect the
 *     write outside the workspace;
 *  3. stale-write — when `expectedMtimeMs` is given, the on-disk mtime must
 *     still match (else `{conflict:true}`), so the editor never clobbers a file
 *     that changed underneath it.
 * Refuses to create missing parent directories or overwrite a directory.
 */
export function writeWorkspaceEntry(workspaceRoot, relPath, content, opts) {
    if (!relPath)
        return { ok: false, path: relPath, error: 'no path' };
    const { ok, resolved } = insideWorkspace(workspaceRoot, relPath);
    if (!ok)
        return { ok: false, path: relPath, error: 'path escapes the workspace' };
    const root = path.resolve(workspaceRoot);
    const inside = (p) => p === root || p.startsWith(root + path.sep);
    // (2) symlink-escape: the real parent must be inside the workspace.
    let realParent;
    try {
        realParent = fs.realpathSync(path.dirname(resolved));
    }
    catch {
        return { ok: false, path: relPath, error: 'parent directory does not exist' };
    }
    if (!inside(realParent))
        return { ok: false, path: relPath, error: 'path escapes the workspace (symlink)' };
    // If the target itself exists, reject directories and symlinks that escape.
    let existed = false;
    try {
        const ls = fs.lstatSync(resolved);
        existed = true;
        if (ls.isDirectory())
            return { ok: false, path: relPath, error: 'path is a directory' };
        if (ls.isSymbolicLink()) {
            const realTarget = fs.realpathSync(resolved);
            if (!inside(realTarget))
                return { ok: false, path: relPath, error: 'path escapes the workspace (symlink)' };
        }
    }
    catch { /* new file — fine */ }
    // (3) stale-write detection.
    if (typeof opts?.expectedMtimeMs === 'number') {
        if (!existed)
            return { ok: false, path: relPath, conflict: true, error: 'file no longer exists' };
        try {
            const st = fs.statSync(resolved);
            // mtimeMs is a float; allow ~1ms slack so identical reads don't false-conflict.
            if (Math.abs(st.mtimeMs - opts.expectedMtimeMs) > 1) {
                return { ok: false, path: relPath, conflict: true, mtimeMs: st.mtimeMs, error: 'file changed on disk since it was opened' };
            }
        }
        catch (err) {
            return { ok: false, path: relPath, error: err instanceof Error ? err.message : String(err) };
        }
    }
    try {
        fs.writeFileSync(resolved, content, 'utf-8');
        const st = fs.statSync(resolved);
        return { ok: true, path: relPath, mtimeMs: st.mtimeMs, size: st.size };
    }
    catch (err) {
        return { ok: false, path: relPath, error: err instanceof Error ? err.message : String(err) };
    }
}
/** True when a workspace-relative path is an existing directory (diff guard). */
export function isWorkspaceDirectory(workspaceRoot, relPath) {
    if (!relPath)
        return false;
    const { ok, resolved } = insideWorkspace(workspaceRoot, relPath);
    if (!ok)
        return false;
    try {
        return fs.statSync(resolved).isDirectory();
    }
    catch {
        return false;
    }
}
