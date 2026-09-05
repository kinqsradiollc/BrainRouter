import {
  BROWSER_BLANK_URL,
  normalizeBrowserAddress,
} from '../../../electron/browser/protocol.js';

export { BROWSER_BLANK_URL };

export type BrowserShortcut =
  | { command: 'new-tab' }
  | { command: 'close-tab' }
  | { command: 'reopen-tab' }
  | { command: 'select-tab'; index: number }
  | { command: 'focus-omnibox' }
  | { command: 'reload'; bypassCache: boolean }
  | { command: 'find' }
  | { command: 'zoom-in' }
  | { command: 'zoom-out' }
  | { command: 'zoom-reset' }
  | { command: 'back' }
  | { command: 'forward' }
  // ADR-055 P10b leftovers — the chrome a person reaches for without a mouse.
  | { command: 'cycle-tab'; delta: -1 | 1 }
  | { command: 'downloads' }
  | { command: 'stop' };

export type BrowserShortcutInput = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

export type BrowserViewRect = { x: number; y: number; width: number; height: number };

/** Keep delayed renderer forwards from moving a live surface handshake backwards. */
export function nextBrowserOpenGeneration(current: number | undefined, incoming: unknown): number | undefined {
  if (!Number.isSafeInteger(incoming) || Number(incoming) <= 0) return current;
  const generation = Number(incoming);
  return current === undefined || generation > current ? generation : current;
}

/**
 * Resolve an omnibox entry without ever returning executable schemes. File URLs
 * are normalized for workspace prototypes, but main performs the authoritative
 * path gate; this keeps renderer behavior deterministic and browser-like.
 */
export function normalizeBrowserInput(raw: string | null | undefined): string | null {
  return normalizeBrowserAddress(raw);
}

/** Map browser-standard accelerators. The shell owns them only while this panel is mounted. */
export function browserShortcut(input: BrowserShortcutInput): BrowserShortcut | null {
  const key = input.key.toLowerCase();
  const primary = !!input.metaKey || !!input.ctrlKey;

  if (input.altKey && !primary && key === 'arrowleft') return { command: 'back' };
  if (input.altKey && !primary && key === 'arrowright') return { command: 'forward' };
  // Esc with no modifier stops the page — the panel lets an editable target keep it.
  if (key === 'escape' && !primary && !input.altKey && !input.shiftKey) return { command: 'stop' };
  if (!primary || input.altKey) return null;
  // ⌘⇧[ / ⌘⇧] cycle tabs (on US layouts shift turns the brackets into braces; both spell the same intent).
  if (input.shiftKey && (key === '[' || key === '{')) return { command: 'cycle-tab', delta: -1 };
  if (input.shiftKey && (key === ']' || key === '}')) return { command: 'cycle-tab', delta: 1 };
  if (input.shiftKey && key === 'j') return { command: 'downloads' };

  if (key === 't') return input.shiftKey ? { command: 'reopen-tab' } : { command: 'new-tab' };
  if (key === 'w' && !input.shiftKey) return { command: 'close-tab' };
  if (key === 'l' && !input.shiftKey) return { command: 'focus-omnibox' };
  if (key === 'r') return { command: 'reload', bypassCache: !!input.shiftKey };
  if (key === 'f' && !input.shiftKey) return { command: 'find' };
  if (key === '+' || key === '=') return { command: 'zoom-in' };
  if (key === '-') return { command: 'zoom-out' };
  if (key === '0') return { command: 'zoom-reset' };
  if (/^[1-9]$/.test(key) && !input.shiftKey) return { command: 'select-tab', index: Number(key) - 1 };
  return null;
}

/** Integer, non-negative Electron content bounds from a DOM client rectangle. */
export function browserViewRect(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>): BrowserViewRect {
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

export function browserTabTitle(title: string | null | undefined, url: string | null | undefined): string {
  const named = (title ?? '').trim();
  if (named) return named;
  if (!url || url === BROWSER_BLANK_URL || url.startsWith('data:text/html')) return 'New tab';
  try { return new URL(url).hostname || 'New tab'; } catch { return 'New tab'; }
}

export function browserZoomLabel(factor: number | null | undefined): string {
  const safe = Number.isFinite(factor) ? Math.min(5, Math.max(0.25, factor as number)) : 1;
  return `${Math.round(safe * 100)}%`;
}

/** True when a keydown landed in something that edits text — a global shortcut like Esc must leave it alone. */
export function shortcutTargetIsEditable(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null };
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true';
}

/** The index the tab strip lands on after cycling `delta` from `activeIndex`, wrapping; -1 when there is nothing to cycle. */
export function cycledTabIndex(activeIndex: number, tabCount: number, delta: -1 | 1): number {
  if (tabCount <= 0) return -1;
  const current = activeIndex >= 0 && activeIndex < tabCount ? activeIndex : 0;
  return (current + delta + tabCount) % tabCount;
}
