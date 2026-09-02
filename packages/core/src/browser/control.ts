/**
 * Versioned command boundary between the agent utility host and Electron's
 * window-owned browser manager. The core package deliberately knows nothing
 * about Electron: Desktop injects one port into the interactive root Agent.
 * CLI/headless/reviewer/child agents receive no port and fail closed without
 * launching a browser process.
 */

export const BROWSER_CONTROL_PROTOCOL_VERSION = 1 as const;
export const MAX_BROWSER_RESULT_CHARS = 64_000;
export const MAX_BROWSER_UPLOAD_FILES = 20;
export const MAX_BROWSER_UPLOAD_PATH_CHARS = 4_096;

export type BrowserControlErrorCode =
  | 'unavailable'
  | 'invalid_request'
  | 'unsafe_url'
  | 'timeout'
  | 'aborted'
  | 'not_found'
  | 'stale_ref'
  | 'ownership_mismatch'
  | 'permission_denied'
  | 'payload_too_large'
  | 'closed'
  | 'unsupported'
  | 'internal';

export interface BrowserControlError {
  code: BrowserControlErrorCode;
  message: string;
}

export interface BrowserTabSummary {
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  pageRevision: number;
  faviconUrl?: string;
  zoomFactor?: number;
}

export interface BrowserCapabilities {
  protocolVersion: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
  tabs: boolean;
  semanticSnapshot: boolean;
  screenshot: boolean;
  console: boolean;
  network: boolean;
  downloads: boolean;
  dialogs: boolean;
  permissions: boolean;
  interactions: string[];
}

interface TabTarget { tabId?: string }
interface RefTarget extends TabTarget { ref?: string; testId?: string; pageRevision?: number; x?: number; y?: number }

export type BrowserControlCommand =
  | { kind: 'capabilities' }
  | { kind: 'tabs.list' }
  | { kind: 'tabs.open'; url?: string; activate?: boolean }
  | { kind: 'tabs.select'; tabId: string }
  | { kind: 'tabs.close'; tabId: string }
  | { kind: 'tabs.reopen' }
  | { kind: 'tabs.reorder'; tabId: string; index: number }
  | ({ kind: 'page.state' } & TabTarget)
  | ({ kind: 'page.navigate'; url: string } & TabTarget)
  | ({ kind: 'page.back' } & TabTarget)
  | ({ kind: 'page.forward' } & TabTarget)
  | ({ kind: 'page.reload'; ignoreCache?: boolean } & TabTarget)
  | ({ kind: 'page.stop' } & TabTarget)
  | ({ kind: 'page.wait'; loadState?: 'domcontentloaded' | 'load' | 'networkidle'; urlIncludes?: string; text?: string; ref?: string; testId?: string; pageRevision?: number; timeoutMs?: number; human?: boolean } & TabTarget)
  | ({ kind: 'page.snapshot'; maxChars?: number; scope?: 'viewport' | 'page' } & TabTarget)
  | ({ kind: 'page.find'; query: string; by?: 'role' | 'text' | 'label' | 'testid'; limit?: number; scope?: 'viewport' | 'page' } & TabTarget)
  | ({ kind: 'page.text'; maxChars?: number } & TabTarget)
  | ({ kind: 'page.html'; maxChars?: number } & TabTarget)
  | ({ kind: 'page.screenshot'; fullPage?: boolean } & TabTarget)
  | ({ kind: 'page.console'; after?: string; limit?: number } & TabTarget)
  | ({ kind: 'page.network'; after?: string; limit?: number } & TabTarget)
  | ({ kind: 'page.downloads'; after?: string; limit?: number } & TabTarget)
  | ({ kind: 'page.click'; button?: 'left' | 'middle' | 'right'; modifiers?: string[] } & RefTarget)
  | ({ kind: 'page.doubleClick'; button?: 'left' | 'middle' | 'right'; modifiers?: string[] } & RefTarget)
  | ({ kind: 'page.hover' } & RefTarget)
  | ({ kind: 'page.type'; text: string; replace?: boolean } & RefTarget)
  | ({ kind: 'page.press'; key: string; modifiers?: string[] } & RefTarget)
  | ({ kind: 'page.scroll'; deltaX?: number; deltaY?: number } & RefTarget)
  | ({ kind: 'page.drag'; fromRef?: string; toRef?: string; fromX?: number; fromY?: number; toX?: number; toY?: number; pageRevision?: number } & TabTarget)
  | ({ kind: 'page.select'; values: string[] } & RefTarget)
  | ({ kind: 'page.check'; checked: boolean } & RefTarget)
  | ({ kind: 'page.setFiles'; files: string[] } & RefTarget)
  | ({ kind: 'page.assertVisible'; timeoutMs?: number } & RefTarget)
  | ({ kind: 'page.setDevice'; device: { name: string; width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean } } & TabTarget)
  | { kind: 'download.action'; downloadId: string; action: 'pause' | 'resume' | 'cancel' | 'open' | 'reveal' }
  | ({ kind: 'dialog.respond'; action: 'accept' | 'dismiss'; promptText?: string } & TabTarget)
  | { kind: 'permission.respond'; origin: string; permission: string; decision: 'allow' | 'deny' };

export interface BrowserControlSuccess {
  ok: true;
  kind: BrowserControlCommand['kind'] | string;
  durationMs: number;
  tabId?: string;
  pageRevision?: number;
  data?: unknown;
}

export interface BrowserControlFailure {
  ok: false;
  kind: BrowserControlCommand['kind'] | string;
  durationMs: number;
  tabId?: string;
  pageRevision?: number;
  error: BrowserControlError;
}

export type BrowserControlResult = BrowserControlSuccess | BrowserControlFailure;

export interface BrowserControlRequestMessage {
  kind: 'browser-command-request';
  version: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
  id: string;
  /** Chat session that owns this browser operation. Desktop uses this to keep
   * agent tabs isolated while the underlying Chromium profile stays shared. */
  sessionKey?: string;
  command: BrowserControlCommand;
}

export interface BrowserControlCancelMessage {
  kind: 'browser-command-cancel';
  version: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
  id: string;
}

export type BrowserControlResponseMessage =
  | {
      kind: 'browser-command-response';
      version: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      kind: 'browser-command-response';
      version: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
      id: string;
      ok: false;
      error: BrowserControlError;
    };

export interface BrowserControlRequestOptions {
  signal?: AbortSignal;
  /** Internal host scope. Normal tools omit this; a session-bound Desktop port
   * supplies it before the request crosses the process boundary. */
  sessionKey?: string;
}

export interface BrowserControlPort {
  request(command: BrowserControlCommand, options?: BrowserControlRequestOptions): Promise<BrowserControlResult>;
}

/** Pure hard gate used when building a turn's tool inventory. */
export function browserUseAvailableFor(input: {
  hasPort: boolean;
  silent: boolean;
  depth: number;
  tier?: string;
  remoteBrain: boolean;
}): boolean {
  return input.hasPort && !input.silent && input.depth === 0 && input.tier !== 'worker' && !input.remoteBrain;
}

export interface BrowserControlTransport { postMessage(message: unknown): void }

export interface BrowserControlBridge extends BrowserControlPort {
  /** Feed a utility-process parentPort message into the correlator. */
  handleMessage(message: unknown): boolean;
  /** Reject every pending request and detach abort listeners. */
  dispose(): void;
}

export class BrowserControlTransportError extends Error {
  constructor(readonly code: BrowserControlErrorCode, message: string) {
    super(message);
    this.name = 'BrowserControlTransportError';
  }
}

function record(value: unknown, label = 'browser command'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserControlTransportError('invalid_request', `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BrowserControlTransportError('invalid_request', `${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new BrowserControlTransportError('invalid_request', `${label} must be a string.`);
  const out = value.trim();
  if (required && !out) throw new BrowserControlTransportError('invalid_request', `${label} is required.`);
  if (out.length > max) throw new BrowserControlTransportError('payload_too_large', `${label} exceeds ${max} characters.`);
  return out;
}

function textString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new BrowserControlTransportError('invalid_request', `${label} must be a string.`);
  if (value.length > max) throw new BrowserControlTransportError('payload_too_large', `${label} exceeds ${max} characters.`);
  return value;
}

function boundedNumber(value: unknown, label: string, min: number, max: number, required = false): number | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BrowserControlTransportError('invalid_request', `${label} is required.`);
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new BrowserControlTransportError('invalid_request', `${label} must be between ${min} and ${max}.`);
  return number;
}

function integer(value: unknown, label: string, min: number, max: number, required = false): number | undefined {
  const number = boundedNumber(value, label, min, max, required);
  if (number !== undefined && !Number.isInteger(number)) throw new BrowserControlTransportError('invalid_request', `${label} must be an integer.`);
  return number;
}

function bool(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BrowserControlTransportError('invalid_request', `${label} must be a boolean.`);
  return value;
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[], required = false): T | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BrowserControlTransportError('invalid_request', `${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string' || !values.includes(value as T)) throw new BrowserControlTransportError('invalid_request', `${label} must be one of: ${values.join(', ')}.`);
  return value as T;
}

function stringArray(value: unknown, label: string, maxItems: number, maxChars: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new BrowserControlTransportError('invalid_request', `${label} must contain at most ${maxItems} strings.`);
  return value.map((entry, index) => textString(entry, `${label}[${index}]`, maxChars));
}

function tabId(row: Record<string, unknown>, required = false): string | undefined {
  return boundedString(row.tabId, 'tabId', 256, required);
}

function revision(row: Record<string, unknown>): number | undefined {
  return integer(row.pageRevision, 'pageRevision', 0, Number.MAX_SAFE_INTEGER);
}

function refTarget(row: Record<string, unknown>, required = true): Pick<RefTarget, 'ref' | 'testId' | 'pageRevision' | 'tabId'> {
  const ref = boundedString(row.ref, 'ref', 512, false);
  const testId = boundedString(row.testId ?? row.testID, 'testId', 512, false);
  if (required && !ref && !testId) throw new BrowserControlTransportError('invalid_request', 'ref or testId is required.');
  return { ...(ref ? { ref } : {}), ...(testId ? { testId } : {}), ...(revision(row) !== undefined ? { pageRevision: revision(row) } : {}), ...(tabId(row) ? { tabId: tabId(row) } : {}) };
}

/** Normalize a user/extension command before it crosses the process boundary. */
export function parseBrowserControlCommand(value: unknown): BrowserControlCommand {
  const row = record(value);
  const kind = boundedString(row.kind, 'kind', 64) as BrowserControlCommand['kind'];
  const target = () => ({ ...(tabId(row) ? { tabId: tabId(row) } : {}) });
  switch (kind) {
    case 'capabilities':
    case 'tabs.list':
    case 'tabs.reopen':
      return { kind };
    case 'tabs.open': {
      const url = row.url === undefined ? undefined : normalizeSafeBrowserUrl(row.url, 'url');
      const activate = bool(row.activate, 'activate');
      return { kind, ...(url ? { url } : {}), ...(activate !== undefined ? { activate } : {}) };
    }
    case 'tabs.select':
    case 'tabs.close':
      return { kind, tabId: tabId(row, true)! };
    case 'tabs.reorder':
      return { kind, tabId: tabId(row, true)!, index: integer(row.index, 'index', 0, 999, true)! };
    case 'page.state':
    case 'page.back':
    case 'page.forward':
    case 'page.stop':
      return { kind, ...target() };
    case 'page.navigate':
      return { kind, url: normalizeSafeBrowserUrl(row.url, 'url'), ...target() };
    case 'page.reload': {
      const ignoreCache = bool(row.ignoreCache, 'ignoreCache');
      return { kind, ...target(), ...(ignoreCache !== undefined ? { ignoreCache } : {}) };
    }
    case 'page.wait': {
      const loadState = enumValue(row.loadState, 'loadState', ['domcontentloaded', 'load', 'networkidle'] as const);
      const urlIncludes = boundedString(row.urlIncludes, 'urlIncludes', 2048, false);
      const text = row.text === undefined ? undefined : textString(row.text, 'text', 4096);
      const ref = boundedString(row.ref, 'ref', 512, false);
      const testId = boundedString(row.testId ?? row.testID, 'testId', 512, false);
      const pageRevision = revision(row);
      const human = bool(row.human, 'human');
      // A human-verification wait may legitimately take minutes; other waits stay short.
      const timeoutMs = integer(row.timeoutMs, 'timeoutMs', 1, human ? 600_000 : 60_000);
      return { kind, ...target(), ...(loadState ? { loadState } : {}), ...(urlIncludes ? { urlIncludes } : {}), ...(text !== undefined ? { text } : {}), ...(ref ? { ref } : {}), ...(testId ? { testId } : {}), ...(pageRevision !== undefined ? { pageRevision } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(human ? { human } : {}) };
    }
    case 'page.snapshot': {
      const maxChars = integer(row.maxChars, 'maxChars', 1_000, 200_000);
      const scope = enumValue(row.scope, 'scope', ['viewport', 'page'] as const);
      return { kind, ...target(), ...(maxChars !== undefined ? { maxChars } : {}), ...(scope ? { scope } : {}) };
    }
    case 'page.find': {
      const query = boundedString(row.query, 'query', 512)!;
      const by = enumValue(row.by, 'by', ['role', 'text', 'label', 'testid'] as const);
      const limit = integer(row.limit, 'limit', 1, 100);
      const scope = enumValue(row.scope, 'scope', ['viewport', 'page'] as const);
      return { kind, query, ...target(), ...(by ? { by } : {}), ...(limit !== undefined ? { limit } : {}), ...(scope ? { scope } : {}) };
    }
    case 'page.text':
    case 'page.html': {
      const maxChars = integer(row.maxChars, 'maxChars', 1_000, 500_000);
      return { kind, ...target(), ...(maxChars !== undefined ? { maxChars } : {}) };
    }
    case 'page.screenshot': {
      const fullPage = bool(row.fullPage, 'fullPage');
      return { kind, ...target(), ...(fullPage !== undefined ? { fullPage } : {}) };
    }
    case 'page.console':
    case 'page.network':
    case 'page.downloads': {
      const after = boundedString(row.after, 'after', 256, false);
      const limit = integer(row.limit, 'limit', 1, 200);
      return { kind, ...target(), ...(after ? { after } : {}), ...(limit !== undefined ? { limit } : {}) };
    }
    case 'page.click':
    case 'page.doubleClick': {
      const button = enumValue(row.button, 'button', ['left', 'middle', 'right'] as const);
      const modifiers = stringArray(row.modifiers, 'modifiers', 8, 32);
      // ADR-055 P2 — a target is a ref/testId OR a screenshot-frame {x,y} point.
      const x = boundedNumber(row.x, 'x', 0, 100_000);
      const y = boundedNumber(row.y, 'y', 0, 100_000);
      const rt = refTarget(row, false);
      if (!rt.ref && !rt.testId && (x === undefined || y === undefined)) {
        throw new BrowserControlTransportError('invalid_request', 'click requires ref, testId, or both x and y.');
      }
      return { kind, ...rt, ...(button ? { button } : {}), ...(modifiers ? { modifiers } : {}), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
    }
    case 'page.hover': {
      const x = boundedNumber(row.x, 'x', 0, 100_000);
      const y = boundedNumber(row.y, 'y', 0, 100_000);
      const rt = refTarget(row, false);
      if (!rt.ref && !rt.testId && (x === undefined || y === undefined)) {
        throw new BrowserControlTransportError('invalid_request', 'hover requires ref, testId, or both x and y.');
      }
      return { kind, ...rt, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
    }
    case 'page.type': {
      const text = textString(row.text, 'text', 20_000);
      const replace = bool(row.replace, 'replace');
      return { kind, ...refTarget(row), text, ...(replace !== undefined ? { replace } : {}) };
    }
    case 'page.press': {
      const key = boundedString(row.key, 'key', 128)!;
      const modifiers = stringArray(row.modifiers, 'modifiers', 8, 32);
      return { kind, ...refTarget(row, false), key, ...(modifiers ? { modifiers } : {}) };
    }
    case 'page.scroll': {
      const deltaX = boundedNumber(row.deltaX, 'deltaX', -100_000, 100_000);
      const deltaY = boundedNumber(row.deltaY, 'deltaY', -100_000, 100_000);
      if (deltaX === undefined && deltaY === undefined) throw new BrowserControlTransportError('invalid_request', 'deltaX or deltaY is required.');
      return { kind, ...refTarget(row, false), ...(deltaX !== undefined ? { deltaX } : {}), ...(deltaY !== undefined ? { deltaY } : {}) };
    }
    case 'page.drag': {
      // ADR-055 P2 — drag by opaque refs OR by two screenshot-frame points.
      const fromRef = boundedString(row.fromRef, 'fromRef', 512, false);
      const toRef = boundedString(row.toRef, 'toRef', 512, false);
      const fromX = boundedNumber(row.fromX, 'fromX', 0, 100_000);
      const fromY = boundedNumber(row.fromY, 'fromY', 0, 100_000);
      const toX = boundedNumber(row.toX, 'toX', 0, 100_000);
      const toY = boundedNumber(row.toY, 'toY', 0, 100_000);
      const hasRefs = !!fromRef && !!toRef;
      const hasCoords = fromX !== undefined && fromY !== undefined && toX !== undefined && toY !== undefined;
      if (!hasRefs && !hasCoords) {
        throw new BrowserControlTransportError('invalid_request', 'drag requires fromRef+toRef or fromX/fromY/toX/toY.');
      }
      return { kind, ...(fromRef ? { fromRef } : {}), ...(toRef ? { toRef } : {}), ...(hasCoords ? { fromX, fromY, toX, toY } : {}), ...target(), ...(revision(row) !== undefined ? { pageRevision: revision(row) } : {}) };
    }
    case 'page.select': {
      const values = stringArray(row.values, 'values', 20, 1024);
      if (!values?.length) throw new BrowserControlTransportError('invalid_request', 'values requires at least one option.');
      return { kind, ...refTarget(row), values };
    }
    case 'page.check': {
      const checked = bool(row.checked, 'checked');
      if (checked === undefined) throw new BrowserControlTransportError('invalid_request', 'checked is required.');
      return { kind, ...refTarget(row), checked };
    }
    case 'page.setFiles': {
      if (!Array.isArray(row.files) || row.files.length === 0 || row.files.length > MAX_BROWSER_UPLOAD_FILES) {
        throw new BrowserControlTransportError('invalid_request', `files must contain between 1 and ${MAX_BROWSER_UPLOAD_FILES} workspace-relative paths.`);
      }
      const files = row.files.map((entry, index) => normalizeWorkspaceRelativeFilePath(entry, `files[${index}]`));
      return { kind, ...refTarget(row), files };
    }
    case 'page.assertVisible': {
      const timeoutMs = integer(row.timeoutMs, 'timeoutMs', 1, 60_000);
      return { kind, ...refTarget(row), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    }
    case 'page.setDevice': {
      const deviceRow = record(row.device, 'device');
      const deviceScaleFactor = boundedNumber(deviceRow.deviceScaleFactor, 'device.deviceScaleFactor', 0.25, 8);
      const isMobile = bool(deviceRow.isMobile, 'device.isMobile');
      return {
        kind,
        ...target(),
        device: {
          name: boundedString(deviceRow.name, 'device.name', 128)!,
          width: integer(deviceRow.width, 'device.width', 200, 10_000, true)!,
          height: integer(deviceRow.height, 'device.height', 200, 10_000, true)!,
          ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
          ...(isMobile !== undefined ? { isMobile } : {}),
        },
      };
    }
    case 'download.action':
      return { kind, downloadId: boundedString(row.downloadId, 'downloadId', 256)!, action: enumValue(row.action, 'action', ['pause', 'resume', 'cancel', 'open', 'reveal'] as const, true)! };
    case 'dialog.respond': {
      const promptText = row.promptText === undefined ? undefined : textString(row.promptText, 'promptText', 4096);
      return { kind, ...target(), action: enumValue(row.action, 'action', ['accept', 'dismiss'] as const, true)!, ...(promptText !== undefined ? { promptText } : {}) };
    }
    case 'permission.respond': {
      const normalized = normalizeSafeBrowserUrl(row.origin, 'origin');
      const origin = normalized === 'about:blank' ? normalized : new URL(normalized).origin;
      return { kind, origin, permission: boundedString(row.permission, 'permission', 128)!, decision: enumValue(row.decision, 'decision', ['allow', 'deny'] as const, true)! };
    }
    default:
      throw new BrowserControlTransportError('invalid_request', `Unsupported browser command: ${String(kind)}.`);
  }
}

/** HTTP(S) only, plus the browser's inert blank page. Main applies stricter destination/IP policy too. */
export function normalizeSafeBrowserUrl(value: unknown, label = 'url'): string {
  const raw = boundedString(value, label, 4096)!;
  if (raw === 'about:blank') return raw;
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrowserControlTransportError('unsafe_url', `${label} must be an absolute HTTP(S) URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserControlTransportError('unsafe_url', `${label} must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new BrowserControlTransportError('unsafe_url', `${label} must not contain credentials.`);
  return url.toString();
}

/**
 * Canonicalize an untrusted upload path without resolving it on this side of
 * the Desktop boundary. The command carries workspace-relative paths only;
 * Desktop must still resolve each path beneath the active workspace and reject
 * symlink escapes before handing absolute paths to Chromium.
 */
export function normalizeWorkspaceRelativeFilePath(value: unknown, label = 'file'): string {
  const raw = boundedString(value, label, MAX_BROWSER_UPLOAD_PATH_CHARS)!;
  if (/[\0-\x1f\x7f]/.test(raw)) {
    throw new BrowserControlTransportError('invalid_request', `${label} contains control characters.`);
  }

  // Treat both separators identically so a path accepted on one host cannot
  // become absolute or traverse outside the workspace on another.
  const portable = raw.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[a-zA-Z]:/.test(portable) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(portable)) {
    throw new BrowserControlTransportError('permission_denied', `${label} must be relative to the active workspace.`);
  }

  const segments: string[] = [];
  for (const segment of portable.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new BrowserControlTransportError('permission_denied', `${label} must not traverse outside the active workspace.`);
    }
    segments.push(segment);
  }
  const normalized = segments.join('/');
  if (!normalized) throw new BrowserControlTransportError('invalid_request', `${label} must name a file inside the active workspace.`);
  return normalized;
}

const SECRET_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'cookies', 'setcookie',
  'password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'cardnumber', 'cvv', 'cvc', 'postdata', 'formdata',
  'requestbody', 'responsebody', 'base64', 'dataurl', 'screenshotbase64',
]);
const SECRET_QUERY_KEYS = new Set(['code', 'token', 'access_token', 'refresh_token', 'api_key', 'key', 'secret', 'password']);
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_ARRAY = 200;
const MAX_VALUE_KEYS = 200;
const MAX_VALUE_STRING = 16_000;

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sensitiveKey(key: string): boolean {
  return SECRET_KEYS.has(normalizedKey(key));
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT REDACTED]');
}

function boundedStringValue(value: string, key: string): string {
  value = redactInlineSecrets(value);
  const normalized = normalizedKey(key);
  if (normalized === 'url' || normalized === 'href' || normalized.endsWith('url')) {
    try {
      const url = new URL(value);
      for (const name of [...url.searchParams.keys()]) {
        if (SECRET_QUERY_KEYS.has(name.toLowerCase()) || sensitiveKey(name)) url.searchParams.set(name, '[REDACTED]');
      }
      if (url.hash && /(?:token|code|secret|password|key)=/i.test(url.hash)) url.hash = '#[REDACTED]';
      value = url.toString();
    } catch { /* a non-URL string keeps normal bounded handling */ }
  }
  return value.length <= MAX_VALUE_STRING ? value : `${value.slice(0, MAX_VALUE_STRING)}…[truncated]`;
}

function boundValue(value: unknown, depth = 0, key = ''): unknown {
  if (sensitiveKey(key)) return key.toLowerCase().includes('base64') || key.toLowerCase().includes('dataurl') ? '[BINARY OMITTED]' : '[REDACTED]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return boundedStringValue(value, key);
  if (depth >= MAX_VALUE_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_VALUE_ARRAY).map((entry) => boundValue(entry, depth + 1));
    if (value.length > MAX_VALUE_ARRAY) out.push(`[${value.length - MAX_VALUE_ARRAY} more items]`);
    return out;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const entries = Object.entries(source);
    const discriminator = String(source.type ?? source.inputType ?? source.role ?? '').toLowerCase();
    const secretNamedValue = typeof source.name === 'string' && sensitiveKey(source.name);
    const secretField = /password|hidden|file|credit.?card|card.?number|cc.?number|cvv|cvc/.test(discriminator);
    const hiddenField = source.visible === false;
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries.slice(0, MAX_VALUE_KEYS)) {
      const normalized = normalizedKey(entryKey);
      out[entryKey] = (secretNamedValue && normalized === 'value') || ((secretField || hiddenField) && (normalized === 'value' || normalized === 'text'))
        ? '[REDACTED]'
        : boundValue(entryValue, depth + 1, entryKey);
    }
    if (entries.length > MAX_VALUE_KEYS) out.__truncatedKeys = entries.length - MAX_VALUE_KEYS;
    return out;
  }
  return String(value ?? '');
}

function boundedData(value: unknown): unknown {
  const bounded = boundValue(value);
  const encoded = JSON.stringify(bounded);
  if (encoded.length <= MAX_BROWSER_RESULT_CHARS) return bounded;
  return { truncated: true, preview: encoded.slice(0, MAX_BROWSER_RESULT_CHARS - 128), omittedChars: encoded.length - MAX_BROWSER_RESULT_CHARS };
}

/** Upload responses never echo local paths or page-provided values to context. */
function boundedUploadData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { accepted: true };
  const row = value as Record<string, unknown>;
  const fileCount = Number(row.fileCount ?? row.count);
  return {
    accepted: row.accepted !== false,
    ...(Number.isSafeInteger(fileCount) && fileCount >= 0 && fileCount <= MAX_BROWSER_UPLOAD_FILES ? { fileCount } : {}),
  };
}

function errorCode(value: unknown): BrowserControlErrorCode {
  const allowed: BrowserControlErrorCode[] = ['unavailable', 'invalid_request', 'unsafe_url', 'timeout', 'aborted', 'not_found', 'stale_ref', 'ownership_mismatch', 'permission_denied', 'payload_too_large', 'closed', 'unsupported', 'internal'];
  return typeof value === 'string' && allowed.includes(value as BrowserControlErrorCode) ? value as BrowserControlErrorCode : 'internal';
}

/** Validate, bound, and redact every desktop response before it reaches model context. */
export function normalizeBrowserControlResult(raw: unknown, fallbackKind: BrowserControlCommand['kind'] | string): BrowserControlResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure(fallbackKind, 'internal', 'Malformed browser response.');
  const row = raw as Record<string, unknown>;
  const kind = typeof row.kind === 'string' && row.kind.length <= 64 ? row.kind : fallbackKind;
  const durationMs = Math.max(0, Math.min(600_000, Number.isFinite(Number(row.durationMs)) ? Number(row.durationMs) : 0));
  const resultTabId = typeof row.tabId === 'string' ? row.tabId.slice(0, 256) : undefined;
  const pageRevision = Number.isSafeInteger(row.pageRevision) && Number(row.pageRevision) >= 0 ? Number(row.pageRevision) : undefined;
  if (row.ok !== true) {
    const rawError = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
    const message = typeof rawError.message === 'string' ? redactInlineSecrets(rawError.message).slice(0, 2_000) : 'Browser command failed.';
    return { ok: false, kind, durationMs, ...(resultTabId ? { tabId: resultTabId } : {}), ...(pageRevision !== undefined ? { pageRevision } : {}), error: { code: errorCode(rawError.code), message } };
  }
  return {
    ok: true,
    kind,
    durationMs,
    ...(resultTabId ? { tabId: resultTabId } : {}),
    ...(pageRevision !== undefined ? { pageRevision } : {}),
    ...(row.data !== undefined ? { data: kind === 'page.setFiles' ? boundedUploadData(row.data) : boundedData(row.data) } : {}),
  };
}

export function failure(kind: BrowserControlCommand['kind'] | string, code: BrowserControlErrorCode, message: string): BrowserControlFailure {
  return { ok: false, kind, durationMs: 0, error: { code, message: redactInlineSecrets(message).slice(0, 2_000) } };
}

export function serializeBrowserControlResult(result: BrowserControlResult): string {
  return JSON.stringify(normalizeBrowserControlResult(result, result.kind));
}

/** Per-invocation backend: no port means a typed refusal, never a fallback browser. */
export class BrowserControlBackend {
  constructor(private readonly port: BrowserControlPort | undefined) {}

  async perform(input: unknown, options: BrowserControlRequestOptions = {}): Promise<BrowserControlResult> {
    let command: BrowserControlCommand;
    try {
      command = parseBrowserControlCommand(input);
    } catch (err) {
      const error = err instanceof BrowserControlTransportError ? err : new BrowserControlTransportError('invalid_request', err instanceof Error ? err.message : String(err));
      return failure(typeof (input as { kind?: unknown })?.kind === 'string' ? String((input as { kind: string }).kind) : 'unknown', error.code === 'unsafe_url' || error.code === 'payload_too_large' ? 'invalid_request' : error.code, error.message);
    }
    if (!this.port) return failure(command.kind, 'unavailable', 'In-app browser control is unavailable. Open BrainRouter Desktop with an active Browser panel.');
    try {
      return normalizeBrowserControlResult(await this.port.request(command, options), command.kind);
    } catch (err) {
      const code = err instanceof BrowserControlTransportError ? err.code : options.signal?.aborted ? 'aborted' : 'internal';
      return failure(command.kind, code, err instanceof Error ? err.message : String(err));
    }
  }
}

interface PendingRequest {
  command: BrowserControlCommand;
  resolve: (result: BrowserControlResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createBrowserControlBridge(
  transport: BrowserControlTransport,
  options: { timeoutMs?: number; idPrefix?: string } = {},
): BrowserControlBridge {
  const pending = new Map<string, PendingRequest>();
  let seq = 0;
  let disposed = false;
  const prefix = (options.idPrefix ?? 'browser').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'browser';
  const timeoutMs = Math.max(100, Math.min(120_000, Math.floor(options.timeoutMs ?? 60_000)));

  const cleanup = (id: string, entry: PendingRequest): void => {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    pending.delete(id);
  };

  return {
    request(commandInput, requestOptions = {}) {
      if (disposed) return Promise.reject(new BrowserControlTransportError('closed', 'Browser control bridge is closed.'));
      let command: BrowserControlCommand;
      try { command = parseBrowserControlCommand(commandInput); }
      catch (err) { return Promise.reject(err); }
      if (requestOptions.signal?.aborted) return Promise.reject(new BrowserControlTransportError('aborted', 'Browser command aborted.'));
      const id = `${prefix}_${++seq}`;
      return new Promise<BrowserControlResult>((resolve, reject) => {
        const entry: PendingRequest = {
          command,
          resolve,
          reject,
          signal: requestOptions.signal,
          timer: setTimeout(() => {
            const current = pending.get(id);
            if (!current) return;
            cleanup(id, current);
            reject(new BrowserControlTransportError('timeout', `Browser command timed out: ${command.kind}.`));
            transport.postMessage({ kind: 'browser-command-cancel', version: BROWSER_CONTROL_PROTOCOL_VERSION, id } satisfies BrowserControlCancelMessage);
          }, timeoutMs),
        };
        if (requestOptions.signal) {
          entry.onAbort = () => {
            if (!pending.has(id)) return;
            cleanup(id, entry);
            reject(new BrowserControlTransportError('aborted', 'Browser command aborted.'));
            transport.postMessage({ kind: 'browser-command-cancel', version: BROWSER_CONTROL_PROTOCOL_VERSION, id } satisfies BrowserControlCancelMessage);
          };
          requestOptions.signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        pending.set(id, entry);
        const sessionKey = requestOptions.sessionKey?.trim();
        transport.postMessage({
          kind: 'browser-command-request',
          version: BROWSER_CONTROL_PROTOCOL_VERSION,
          id,
          ...(sessionKey ? { sessionKey: sessionKey.slice(0, 512) } : {}),
          command,
        } satisfies BrowserControlRequestMessage);
      });
    },
    handleMessage(message: unknown): boolean {
      if (!message || typeof message !== 'object') return false;
      const row = message as Record<string, unknown>;
      if (row.kind !== 'browser-command-response' || typeof row.id !== 'string') return false;
      const entry = pending.get(row.id);
      if (!entry) return true;
      cleanup(row.id, entry);
      if (row.version !== BROWSER_CONTROL_PROTOCOL_VERSION) {
        entry.reject(new BrowserControlTransportError('unsupported', 'Unsupported browser-control protocol version.'));
        return true;
      }
      if (row.ok === true) {
        entry.resolve(normalizeBrowserControlResult(row.result, entry.command.kind));
      } else {
        const rawError = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
        entry.reject(new BrowserControlTransportError(errorCode(rawError.code), typeof rawError.message === 'string' ? rawError.message.slice(0, 2_000) : 'Browser command failed.'));
      }
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [id, entry] of pending) {
        cleanup(id, entry);
        entry.reject(new BrowserControlTransportError('closed', 'Browser control bridge is closed.'));
      }
    },
  };
}

export function isBrowserControlRequestMessage(value: unknown): value is BrowserControlRequestMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'browser-command-request' || row.version !== BROWSER_CONTROL_PROTOCOL_VERSION || typeof row.id !== 'string' || row.id.length > 128) return false;
  if (row.sessionKey !== undefined && (typeof row.sessionKey !== 'string' || row.sessionKey.length < 1 || row.sessionKey.length > 512)) return false;
  try { parseBrowserControlCommand(row.command); return true; } catch { return false; }
}

export function isBrowserControlCancelMessage(value: unknown): value is BrowserControlCancelMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.kind === 'browser-command-cancel' && row.version === BROWSER_CONTROL_PROTOCOL_VERSION && typeof row.id === 'string' && row.id.length <= 128;
}
