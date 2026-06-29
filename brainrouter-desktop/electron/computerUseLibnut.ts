import { createRequire } from 'node:module';

export type LibnutBinding = {
  moveMouse(x: number, y: number): void;
  mouseClick(button?: string, doubleClick?: boolean): void;
  mouseToggle(state: 'down' | 'up', button?: string): void;
  scrollMouse(x: number, y: number): void;
  typeString(text: string): void;
  keyTap(key: string, modifiers?: string[]): void;
};

export type LibnutLoadResult =
  | { ok: true; libnut: LibnutBinding }
  | { ok: false; error: string };

let cached: LibnutLoadResult | null = null;

export function resetLibnutCacheForTests(): void {
  cached = null;
}

export function loadLibnut(): LibnutLoadResult {
  if (cached) return cached;
  if (process.platform === 'linux' && (process.env.WAYLAND_DISPLAY || '').trim() && !(process.env.DISPLAY || '').trim()) {
    cached = { ok: false, error: 'Native computer control is unavailable on pure Wayland. Run under X11/XWayland.' };
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@nut-tree-fork/libnut/dist/import_libnut.js') as { libnut?: LibnutBinding };
    if (!mod?.libnut) throw new Error('libnut binding did not export libnut');
    cached = { ok: true, libnut: mod.libnut };
    return cached;
  } catch (err) {
    cached = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return cached;
  }
}
