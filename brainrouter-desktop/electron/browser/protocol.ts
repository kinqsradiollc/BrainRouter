/**
 * Versioned, bounded contract shared by the renderer, Electron main process and
 * the desktop utility host. This module deliberately has no Electron/Node imports
 * so Vite can consume it without granting renderer capabilities.
 */

export const BROWSER_PROTOCOL_VERSION = 1 as const;
export const MAX_BROWSER_TABS = 50;
export const MAX_BROWSER_TEXT = 4_096;
export const MAX_BROWSER_ROWS = 500;
export const MAX_BROWSER_IMAGE_BYTES = 8 * 1024 * 1024;
export const BROWSER_BLANK_URL = 'data:text/html,%3C!doctype%20html%3E%3Cmeta%20charset%3Dutf-8%3E%3Cmeta%20name%3Dviewport%20content%3D%22width%3Ddevice-width%2Cinitial-scale%3D1%22%3E%3Ctitle%3ENew%20tab%3C%2Ftitle%3E';

export type BrowserTabId = string;
export type BrowserDownloadId = string;
export type OpaqueBrowserRef = string;

export interface BrowserSurface {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface BrowserTab {
  id: BrowserTabId;
  url: string;
  title: string;
  faviconUrl: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  audible: boolean;
  muted: boolean;
  zoomFactor: number;
  revision: number;
  lastAccessedAt: number;
}

export interface BrowserDownload {
  id: BrowserDownloadId;
  tabId: BrowserTabId | null;
  filename: string;
  url: string;
  savePath: string | null;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startedAt: number;
}

export interface BrowserPermissionPrompt {
  id: string;
  tabId: BrowserTabId;
  origin: string;
  permission: string;
}

export interface BrowserDialogPrompt {
  id: string;
  tabId: BrowserTabId;
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'certificate';
  message: string;
  defaultValue?: string;
  /** Display-only site identity for certificate decisions. */
  origin?: string;
}

export interface BrowserCapabilities {
  nativeTabs: true;
  sameVisibleTabAutomation: true;
  downloads: true;
  permissions: true;
  semanticSnapshot: true;
  maxTabs: number;
}

export interface BrowserState {
  version: typeof BROWSER_PROTOCOL_VERSION;
  activeTabId: BrowserTabId;
  tabs: BrowserTab[];
  closedTabCount: number;
  surface: BrowserSurface;
  downloads: BrowserDownload[];
  permissionPrompt: BrowserPermissionPrompt | null;
  dialogPrompt: BrowserDialogPrompt | null;
  capabilities: BrowserCapabilities;
}

export interface BrowserSemanticNode {
  ref: OpaqueBrowserRef;
  role: string;
  name: string;
  tag: string;
  testid?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  source: string;
  line: number;
  at: number;
}

export interface BrowserNetworkEntry {
  url: string;
  method: string;
  status: number;
  kind: string;
  durationMs: number;
  transferBytes: number;
  at: number;
}

export type BrowserCommand =
  | { op: 'state' }
  | { op: 'create-tab'; url?: string; active?: boolean; openerTabId?: BrowserTabId }
  | { op: 'select-tab'; tabId: BrowserTabId }
  | { op: 'close-tab'; tabId?: BrowserTabId }
  | { op: 'reopen-tab' }
  | { op: 'reorder-tab'; tabId: BrowserTabId; toIndex: number }
  | { op: 'navigate'; url: string }
  | { op: 'back' }
  | { op: 'forward' }
  | { op: 'reload'; bypassCache?: boolean }
  | { op: 'stop' }
  | { op: 'find'; text: string; forward?: boolean; findNext?: boolean }
  | { op: 'stop-find'; action?: 'clearSelection' | 'keepSelection' | 'activateSelection' }
  | { op: 'set-zoom'; factor: number }
  | { op: 'set-muted'; muted: boolean }
  | { op: 'snapshot'; mode?: 'semantic' | 'testids' | 'accessibility' }
  | { op: 'text'; maxChars?: number }
  | { op: 'html'; maxChars?: number }
  | { op: 'screenshot'; maxDimension?: number; fullPage?: boolean }
  | { op: 'console'; clear?: boolean }
  | { op: 'network'; clear?: boolean }
  | { op: 'downloads' }
  | { op: 'click' | 'double-click' | 'hover' | 'assert-visible' | 'highlight'; ref?: OpaqueBrowserRef; target?: string; label?: string; targetType?: string; button?: 'left' | 'middle' | 'right'; modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> }
  | { op: 'type'; ref?: OpaqueBrowserRef; target?: string; text: string; replace?: boolean }
  | { op: 'press'; key: string; modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> }
  | { op: 'scroll'; x?: number; y?: number; deltaX?: number; deltaY: number }
  | { op: 'drag'; fromRef: OpaqueBrowserRef; toRef: OpaqueBrowserRef }
  | { op: 'select'; ref?: OpaqueBrowserRef; target?: string; values: string[] }
  | { op: 'check'; ref?: OpaqueBrowserRef; target?: string; checked: boolean }
  | { op: 'set-files'; ref?: OpaqueBrowserRef; target?: string; files: string[] }
  | { op: 'set-cursor'; enabled: boolean }
  | { op: 'set-device'; device: { name: string; width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean } }
  | { op: 'clear-highlight' }
  | { op: 'respond-permission'; promptId: string; allow: boolean }
  | { op: 'respond-dialog'; promptId: string; accept: boolean; value?: string }
  | { op: 'open-download' | 'show-download' | 'cancel-download' | 'pause-download' | 'resume-download'; downloadId: BrowserDownloadId }
  | { op: 'clear-data'; dataTypes?: Array<'cache' | 'cookies' | 'storage' | 'history'> };

export interface BrowserCommandRequest {
  version: typeof BROWSER_PROTOCOL_VERSION;
  id: string;
  tabId?: BrowserTabId;
  expectedRevision?: number;
  timeoutMs?: number;
  command: BrowserCommand;
}

export type BrowserErrorCode =
  | 'UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'UNSAFE_URL'
  | 'TAB_NOT_FOUND'
  | 'TAB_LIMIT'
  | 'STALE_PAGE'
  | 'REF_NOT_FOUND'
  | 'NOT_READY'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'DENIED'
  | 'CANCELLED'
  | 'INTERNAL';

export type BrowserCommandResult<T = unknown> =
  | { ok: true; requestId: string; tabId: BrowserTabId; revision: number; value: T }
  | { ok: false; requestId: string; code: BrowserErrorCode; error: string; tabId?: BrowserTabId; revision?: number };

export type BrowserEvent =
  | { type: 'state'; state: BrowserState }
  | { type: 'focus-location' | 'focus-find'; tabId: BrowserTabId }
  | { type: 'status'; tabId: BrowserTabId; text: string }
  | { type: 'download'; download: BrowserDownload }
  | { type: 'permission'; prompt: BrowserPermissionPrompt | null }
  | { type: 'dialog'; prompt: BrowserDialogPrompt | null };

export interface BrowserControlPort {
  request<T = unknown>(request: BrowserCommandRequest, signal?: AbortSignal): Promise<BrowserCommandResult<T>>;
}

const COMMAND_OPS = new Set<BrowserCommand['op']>([
  'state', 'create-tab', 'select-tab', 'close-tab', 'reopen-tab', 'reorder-tab',
  'navigate', 'back', 'forward', 'reload', 'stop', 'find', 'stop-find', 'set-zoom',
  'set-muted', 'snapshot', 'screenshot', 'console', 'network', 'downloads', 'click',
  'double-click', 'hover', 'assert-visible', 'highlight', 'type', 'press', 'scroll',
  'drag', 'select', 'check', 'set-files', 'set-cursor', 'set-device', 'clear-highlight', 'respond-permission',
  'respond-dialog', 'open-download', 'show-download', 'cancel-download', 'pause-download', 'resume-download', 'clear-data',
]);

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|sessionid)/i;

export function boundBrowserText(value: unknown, max = MAX_BROWSER_TEXT): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length <= max ? text : text.slice(0, Math.max(0, max));
}

export function boundBrowserArray<T>(value: readonly T[], max = MAX_BROWSER_ROWS): T[] {
  return value.slice(0, Math.max(0, Math.floor(max)));
}

export function redactBrowserValue(value: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return boundBrowserText(value);
  if (Array.isArray(value)) return boundBrowserArray(value).map((entry) => redactBrowserValue(entry, '', depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value).slice(0, MAX_BROWSER_ROWS)) {
    out[boundBrowserText(childKey, 128)] = redactBrowserValue(child, childKey, depth + 1);
  }
  return out;
}

export function normalizeBrowserAddress(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (value.toLowerCase() === 'about:blank') return BROWSER_BLANK_URL;
  if (/^https?:\/\//i.test(value)) {
    try { return new URL(value).href; } catch { return null; }
  }
  if (/^data:text\/html(?:[;,]|$)/i.test(value)) return value;
  // File URLs are normalized here but remain denied by default. Electron main's
  // workspace-aware policy admits only authorized prototype files below the
  // active workspace and rejects every traversal/out-of-tree path.
  if (/^file:\/\//i.test(value)) {
    try { return new URL(value).href; } catch { return null; }
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(?:\/|$)/i.test(value)) return `http://${value}`;
  if (!/\s/.test(value) && /\./.test(value) && /^[\w.\-~:/?#[\]@!$&'()*+,;=%]+$/.test(value)) {
    try { return new URL(`https://${value}`).href; } catch { /* search below */ }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function clampBrowserSurface(
  surface: BrowserSurface,
  owner: { width: number; height: number },
): BrowserSurface {
  const ownerWidth = Math.max(0, Math.floor(owner.width));
  const ownerHeight = Math.max(0, Math.floor(owner.height));
  const x = Math.min(ownerWidth, Math.max(0, Math.floor(Number.isFinite(surface.x) ? surface.x : 0)));
  const y = Math.min(ownerHeight, Math.max(0, Math.floor(Number.isFinite(surface.y) ? surface.y : 0)));
  const width = Math.min(ownerWidth - x, Math.max(0, Math.floor(Number.isFinite(surface.width) ? surface.width : 0)));
  const height = Math.min(ownerHeight - y, Math.max(0, Math.floor(Number.isFinite(surface.height) ? surface.height : 0)));
  return { x, y, width, height, visible: surface.visible === true };
}

export function isOpaqueBrowserRef(value: unknown): value is OpaqueBrowserRef {
  return typeof value === 'string' && /^br:tab_[A-Za-z0-9_-]+:\d+:node_[A-Za-z0-9_-]+$/.test(value);
}

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  if (!value || typeof value !== 'object') return false;
  const op = (value as { op?: unknown }).op;
  if (typeof op !== 'string' || !COMMAND_OPS.has(op as BrowserCommand['op'])) return false;
  try {
    // Renderer IPC is not a trust boundary. Reject oversized envelopes before a
    // compromised renderer can make main allocate unbounded strings/arrays.
    return JSON.stringify(value).length <= 256 * 1024;
  } catch {
    return false;
  }
}

export function isBrowserCommandRequest(value: unknown): value is BrowserCommandRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<BrowserCommandRequest>;
  if (request.version !== BROWSER_PROTOCOL_VERSION) return false;
  if (typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 128) return false;
  if (request.tabId !== undefined && (typeof request.tabId !== 'string' || request.tabId.length > 128)) return false;
  if (request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) return false;
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120_000)) return false;
  return isBrowserCommand(request.command);
}
