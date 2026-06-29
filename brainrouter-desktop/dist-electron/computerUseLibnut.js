import { createRequire } from 'node:module';
let cached = null;
export function resetLibnutCacheForTests() {
    cached = null;
}
export function loadLibnut() {
    if (cached)
        return cached;
    if (process.platform === 'linux' && (process.env.WAYLAND_DISPLAY || '').trim() && !(process.env.DISPLAY || '').trim()) {
        cached = { ok: false, error: 'Native computer control is unavailable on pure Wayland. Run under X11/XWayland.' };
        return cached;
    }
    try {
        const require = createRequire(import.meta.url);
        const mod = require('@nut-tree-fork/libnut/dist/import_libnut.js');
        if (!mod?.libnut)
            throw new Error('libnut binding did not export libnut');
        cached = { ok: true, libnut: mod.libnut };
        return cached;
    }
    catch (err) {
        cached = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return cached;
    }
}
