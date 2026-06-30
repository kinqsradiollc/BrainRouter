import { BrowserWindow, desktopCapturer, screen } from 'electron';
import type { AgentImage, ComputerUseAction, ComputerUseActionResult, ComputerUsePort } from '@kinqs/brainrouter-agent-protocol';
import { expandChordKeys } from '@kinqs/brainrouter-core/agent';
import { checkComputerUsePermissions } from './computerUsePermissions.js';
import { loadLibnut, type LibnutBinding } from './computerUseLibnut.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeWindow(windowProvider?: () => BrowserWindow | null): BrowserWindow | null {
  return windowProvider?.() ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function displayForWindow(win: BrowserWindow | null): Electron.Display {
  if (!win) return screen.getPrimaryDisplay();
  const bounds = win.getBounds();
  return screen.getDisplayNearestPoint({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) });
}

function toNativePoint(x: number, y: number, win: BrowserWindow | null): { x: number; y: number } {
  const display = displayForWindow(win);
  const scale = display.scaleFactor || 1;
  return { x: Math.round(x * scale), y: Math.round(y * scale) };
}

async function withHiddenWindow<T>(win: BrowserWindow | null, fn: () => Promise<T>): Promise<T> {
  if (!win || win.isDestroyed()) return fn();
  const oldOpacity = win.getOpacity();
  try {
    try { win.setContentProtection(true); } catch { /* best effort */ }
    win.setOpacity(0);
    await sleep(80);
    return await fn();
  } finally {
    try { win.setOpacity(oldOpacity); } catch { /* best effort */ }
    try { win.setContentProtection(false); } catch { /* best effort */ }
  }
}

async function screenshot(windowProvider?: () => BrowserWindow | null): Promise<AgentImage> {
  const win = activeWindow(windowProvider);
  const display = displayForWindow(win);
  const image = await withHiddenWindow(win, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: display.size,
    });
    return sources.find((source) => source.display_id === String(display.id))?.thumbnail ?? sources[0]?.thumbnail;
  });
  if (!image || image.isEmpty()) throw new Error('No screen source was available for capture.');
  return { mediaType: 'image/jpeg', dataBase64: image.toJPEG(70).toString('base64') };
}

function permissionDeniedFor(action: ComputerUseAction): ComputerUseActionResult | null {
  const permissions = checkComputerUsePermissions();
  if (process.platform === 'darwin' && action.action === 'screenshot' && !permissions.screen.granted) {
    return { success: false, permissionDenied: true, error: `Screen Recording permission is ${permissions.screen.status}.` };
  }
  if (process.platform === 'darwin' && action.action !== 'screenshot' && !permissions.accessibility.granted) {
    return { success: false, permissionDenied: true, error: 'Accessibility permission is required for native input.' };
  }
  return null;
}

async function move(libnut: LibnutBinding, action: ComputerUseAction, win: BrowserWindow | null): Promise<void> {
  const p = toNativePoint(action.x ?? 0, action.y ?? 0, win);
  libnut.moveMouse(p.x, p.y);
}

async function click(libnut: LibnutBinding, action: ComputerUseAction, win: BrowserWindow | null, double = false): Promise<void> {
  await move(libnut, action, win);
  libnut.mouseClick(action.button ?? (action.action === 'right_click' ? 'right' : 'left'), double);
}

async function scroll(libnut: LibnutBinding, action: ComputerUseAction): Promise<void> {
  const clicks = Math.max(1, Math.min(20, Math.floor(action.clicks ?? 1)));
  const direction = action.direction ?? 'down';
  for (let i = 0; i < clicks; i += 1) {
    if (direction === 'up') libnut.scrollMouse(0, 1);
    else if (direction === 'down') libnut.scrollMouse(0, -1);
    else if (direction === 'left') libnut.scrollMouse(-1, 0);
    else libnut.scrollMouse(1, 0);
    await sleep(25);
  }
}

async function drag(libnut: LibnutBinding, action: ComputerUseAction, win: BrowserWindow | null): Promise<void> {
  const start = toNativePoint(action.x ?? 0, action.y ?? 0, win);
  const end = toNativePoint(action.x2 ?? action.x ?? 0, action.y2 ?? action.y ?? 0, win);
  libnut.moveMouse(start.x, start.y);
  await sleep(40);
  libnut.mouseToggle('down', action.button ?? 'left');
  await sleep(40);
  libnut.moveMouse(end.x, end.y);
  await sleep(40);
  libnut.mouseToggle('up', action.button ?? 'left');
}

async function key(libnut: LibnutBinding, action: ComputerUseAction): Promise<void> {
  if (!action.keys) return;
  const keys = expandChordKeys(action.keys);
  const primary = keys[keys.length - 1];
  const modifiers = keys.slice(0, -1);
  if (primary) libnut.keyTap(primary, modifiers);
}

export function createComputerUsePort(windowProvider?: () => BrowserWindow | null): ComputerUsePort {
  return {
    async screenshot(): Promise<AgentImage> {
      const denied = permissionDeniedFor({ action: 'screenshot' });
      if (denied) throw new Error(denied.error);
      return screenshot(windowProvider);
    },
    async act(action: ComputerUseAction): Promise<ComputerUseActionResult> {
      const denied = permissionDeniedFor(action);
      if (denied) return denied;
      const loaded = loadLibnut();
      if (!loaded.ok) return { success: false, permissionDenied: true, error: loaded.error };
      const win = activeWindow(windowProvider);
      try {
        switch (action.action) {
          case 'move':
            await move(loaded.libnut, action, win);
            break;
          case 'left_click':
          case 'right_click':
            await click(loaded.libnut, action, win);
            break;
          case 'double_click':
            await click(loaded.libnut, action, win, true);
            break;
          case 'type':
            loaded.libnut.typeString(action.text ?? '');
            break;
          case 'key':
            await key(loaded.libnut, action);
            break;
          case 'scroll':
            await scroll(loaded.libnut, action);
            break;
          case 'drag':
            await drag(loaded.libnut, action, win);
            break;
          case 'screenshot':
            break;
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
