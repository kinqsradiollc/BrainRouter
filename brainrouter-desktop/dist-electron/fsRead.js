import fs from 'node:fs';
import path from 'node:path';
const MAX_BYTES = 200_000;
function insideWorkspace(workspaceRoot, relPath) {
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, relPath);
    const ok = resolved === root || resolved.startsWith(root + path.sep);
    return { ok, resolved };
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
        const content = fs.readFileSync(resolved, 'utf-8');
        return { path: relPath, kind: 'file', content: content.slice(0, MAX_BYTES), truncated: content.length > MAX_BYTES };
    }
    catch (err) {
        return { path: relPath, kind: 'file', content: '', error: err instanceof Error ? err.message : String(err) };
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
