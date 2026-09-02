import type {
  BrowserControlCommand,
  BrowserControlErrorCode,
  BrowserControlResult,
} from '@kinqs/brainrouter-core/browser';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSER_PROTOCOL_VERSION,
  MAX_BROWSER_IMAGE_BYTES,
  type BrowserCommand,
  type BrowserCommandRequest,
  type BrowserCommandResult,
  type BrowserErrorCode,
  type BrowserState,
  type BrowserTab,
} from './protocol.js';

export interface BrowserManagerPort {
  getState(): BrowserState;
  execute(request: BrowserCommandRequest, signal?: AbortSignal): Promise<BrowserCommandResult>;
}

export interface AgentBrowserRequest {
  id: string;
  command: BrowserControlCommand;
}

export interface MappedAgentBrowserCommand {
  command: BrowserCommand;
  tabId?: string;
  expectedRevision?: number;
  /** A safe manager command used to resolve/focus an element before an input. */
  targetPreparation?: {
    kind: 'focus' | 'pointer';
    ref?: string;
    target?: string;
  };
}

class AdapterError extends Error {
  constructor(readonly code: BrowserControlErrorCode, message: string) { super(message); }
}

function refTarget(command: { tabId?: string; pageRevision?: number; ref?: string; testId?: string }): Pick<MappedAgentBrowserCommand, 'tabId' | 'expectedRevision'> & { ref?: string; target?: string } {
  return { tabId: command.tabId, expectedRevision: command.pageRevision, ref: command.ref, target: command.testId };
}

function safeAgentUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new AdapterError('unsafe_url', 'Browser URL must be absolute HTTP(S).'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AdapterError('unsafe_url', 'Browser URL must use HTTP(S) and contain no credentials.');
  return url.href;
}

export function mapAgentBrowserCommand(command: BrowserControlCommand): MappedAgentBrowserCommand {
  switch (command.kind) {
    case 'tabs.open': return { command: { op: 'create-tab', url: safeAgentUrl(command.url), active: command.activate === true } };
    case 'tabs.select': return { command: { op: 'select-tab', tabId: command.tabId } };
    case 'tabs.close': return { command: { op: 'close-tab', tabId: command.tabId } };
    case 'tabs.reopen': return { command: { op: 'reopen-tab' } };
    case 'tabs.reorder': return { command: { op: 'reorder-tab', tabId: command.tabId, toIndex: command.index } };
    case 'page.navigate': return { tabId: command.tabId, command: { op: 'navigate', url: safeAgentUrl(command.url)! } };
    case 'page.back': return { tabId: command.tabId, command: { op: 'back' } };
    case 'page.forward': return { tabId: command.tabId, command: { op: 'forward' } };
    case 'page.reload': return { tabId: command.tabId, command: { op: 'reload', bypassCache: command.ignoreCache } };
    case 'page.stop': return { tabId: command.tabId, command: { op: 'stop' } };
    case 'page.snapshot': return { tabId: command.tabId, command: { op: 'snapshot', mode: 'semantic', scope: command.scope } };
    case 'page.find': return { tabId: command.tabId, command: { op: 'find-nodes', query: command.query, by: command.by, limit: command.limit, scope: command.scope } };
    case 'page.text': return { tabId: command.tabId, command: { op: 'text', maxChars: command.maxChars } };
    case 'page.html': return { tabId: command.tabId, command: { op: 'html', maxChars: command.maxChars } };
    case 'page.screenshot': return { tabId: command.tabId, command: { op: 'screenshot', fullPage: command.fullPage } };
    case 'page.console': return { tabId: command.tabId, command: { op: 'console' } };
    case 'page.network': return { tabId: command.tabId, command: { op: 'network' } };
    case 'page.downloads': return { tabId: command.tabId, command: { op: 'downloads' } };
    case 'page.click': {
      const target = refTarget(command);
      return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'click', ref: target.ref, target: target.target, x: command.x, y: command.y, button: command.button, modifiers: command.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'> | undefined } };
    }
    case 'page.doubleClick': {
      const target = refTarget(command);
      return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'double-click', ref: target.ref, target: target.target, x: command.x, y: command.y, button: command.button, modifiers: command.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'> | undefined } };
    }
    case 'page.hover': {
      const target = refTarget(command); return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'hover', ref: target.ref, target: target.target, x: command.x, y: command.y } };
    }
    case 'page.type': {
      const target = refTarget(command); return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'type', ref: target.ref, target: target.target, text: command.text, replace: command.replace } };
    }
    case 'page.press': {
      const target = refTarget(command);
      return {
        tabId: target.tabId,
        expectedRevision: target.expectedRevision,
        command: { op: 'press', key: command.key, modifiers: command.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'> | undefined },
        ...(target.ref || target.target ? { targetPreparation: { kind: 'focus' as const, ref: target.ref, target: target.target } } : {}),
      };
    }
    case 'page.scroll': {
      const target = refTarget(command);
      return {
        tabId: target.tabId,
        expectedRevision: target.expectedRevision,
        command: { op: 'scroll', deltaX: command.deltaX, deltaY: command.deltaY ?? 0 },
        ...(target.ref || target.target ? { targetPreparation: { kind: 'pointer' as const, ref: target.ref, target: target.target } } : {}),
      };
    }
    case 'page.drag': return { tabId: command.tabId, expectedRevision: command.pageRevision, command: { op: 'drag', fromRef: command.fromRef, toRef: command.toRef, fromX: command.fromX, fromY: command.fromY, toX: command.toX, toY: command.toY } };
    case 'page.select': {
      const target = refTarget(command); return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'select', ref: target.ref, target: target.target, values: command.values } };
    }
    case 'page.check': {
      const target = refTarget(command); return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'check', ref: target.ref, target: target.target, checked: command.checked } };
    }
    case 'page.setFiles': {
      const target = refTarget(command); return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'set-files', ref: target.ref, target: target.target, files: command.files } };
    }
    case 'page.assertVisible': {
      const target = refTarget(command); return { tabId: target.tabId, expectedRevision: target.expectedRevision, command: { op: 'assert-visible', ref: target.ref, target: target.target } };
    }
    case 'page.setDevice': return { tabId: command.tabId, command: { op: 'set-device', device: command.device } };
    case 'download.action': {
      const op: BrowserCommand['op'] = command.action === 'open' ? 'open-download'
        : command.action === 'reveal' ? 'show-download'
          : command.action === 'cancel' ? 'cancel-download'
            : command.action === 'pause' ? 'pause-download'
              : 'resume-download';
      return { command: { op, downloadId: command.downloadId } as BrowserCommand };
    }
    default:
      throw new AdapterError('unsupported', `Desktop adapter does not map ${command.kind}.`);
  }
}

function tabSummary(tab: BrowserTab, activeTabId: string): Record<string, unknown> {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.id === activeTabId,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    crashed: tab.crashed,
    pageRevision: tab.revision,
    ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
    zoomFactor: tab.zoomFactor,
  };
}

function coreError(code: BrowserErrorCode): BrowserControlErrorCode {
  const mapping: Record<string, BrowserControlErrorCode> = {
    UNAVAILABLE: 'unavailable', INVALID_REQUEST: 'invalid_request', UNSAFE_URL: 'unsafe_url',
    TAB_NOT_FOUND: 'not_found', TAB_LIMIT: 'invalid_request', STALE_PAGE: 'stale_ref',
    REF_NOT_FOUND: 'not_found', NOT_READY: 'unavailable', TIMEOUT: 'timeout',
    TOO_LARGE: 'payload_too_large', DENIED: 'permission_denied', CANCELLED: 'aborted', INTERNAL: 'internal',
  };
  return mapping[String(code)] ?? 'internal';
}

function success(kind: string, startedAt: number, data: unknown, tabId?: string, pageRevision?: number): BrowserControlResult {
  return { ok: true, kind, durationMs: Date.now() - startedAt, ...(tabId ? { tabId } : {}), ...(pageRevision !== undefined ? { pageRevision } : {}), data };
}

function failure(kind: string, startedAt: number, code: BrowserControlErrorCode, message: string, tabId?: string, pageRevision?: number): BrowserControlResult {
  return { ok: false, kind, durationMs: Date.now() - startedAt, ...(tabId ? { tabId } : {}), ...(pageRevision !== undefined ? { pageRevision } : {}), error: { code, message: message.slice(0, 2_000) } };
}

const SCREENSHOT_DIRECTORY_SEGMENTS = ['.brainrouter', 'browser', 'screenshots'] as const;

function artifactPathFailure(): AdapterError {
  return new AdapterError('permission_denied', 'Browser screenshot artifact storage path is unavailable or unsafe.');
}

function sanitizedArtifactStorageError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST' || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return artifactPathFailure();
  return new AdapterError('internal', 'Browser screenshot artifact could not be saved securely.');
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isCanonicalPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Build the artifact directory one component at a time. Recursive mkdir would
 * follow an existing `.brainrouter`, `browser`, or `screenshots` symlink before
 * the caller could validate it.
 */
function secureScreenshotDirectory(workspaceRoot: string, createMissing: boolean): { workspace: string; directory: string } {
  const workspace = fs.realpathSync(workspaceRoot);
  const workspaceStat = fs.statSync(workspace);
  if (!workspaceStat.isDirectory()) throw artifactPathFailure();

  let parent = workspace;
  for (const segment of SCREENSHOT_DIRECTORY_SEGMENTS) {
    const candidate = path.join(parent, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (!createMissing || !isMissingPathError(error)) throw error;
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        // A racing creator is safe only if the lstat checks below prove it
        // created the expected real directory rather than a link.
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(candidate);
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) throw artifactPathFailure();
    const canonical = fs.realpathSync(candidate);
    if (!isCanonicalPathInside(workspace, canonical) || path.dirname(canonical) !== parent) throw artifactPathFailure();
    parent = canonical;
  }
  return { workspace, directory: parent };
}

function safeScreenshotOpenFlags(): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  return fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
}

function writeScreenshotFile(workspaceRoot: string, filename: string, bytes: Buffer): { workspace: string; absolute: string } {
  let initial: { workspace: string; directory: string };
  try {
    initial = secureScreenshotDirectory(workspaceRoot, true);
  } catch (error) {
    throw sanitizedArtifactStorageError(error);
  }
  const absolute = path.join(initial.directory, filename);
  let descriptor: number | undefined;
  let openedStat: fs.Stats | undefined;

  try {
    // Refuse even a benign existing file: screenshots are immutable artifacts,
    // and O_EXCL + O_NOFOLLOW closes the target replacement/symlink race.
    try {
      fs.lstatSync(absolute);
      throw artifactPathFailure();
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    // Revalidate every ancestor immediately before creating the file.
    const beforeOpen = secureScreenshotDirectory(initial.workspace, false);
    if (beforeOpen.directory !== initial.directory) throw artifactPathFailure();
    descriptor = fs.openSync(absolute, safeScreenshotOpenFlags(), 0o600);
    openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile() || openedStat.nlink !== 1) throw artifactPathFailure();

    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Screenshot artifact write did not make progress.');
      offset += written;
    }

    // Verify the pathname still names the exact file descriptor and that no
    // ancestor was replaced while the bytes were being written.
    const pathStat = fs.lstatSync(absolute);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFilesystemEntry(openedStat, pathStat)) throw artifactPathFailure();
    const afterWrite = secureScreenshotDirectory(initial.workspace, false);
    const canonicalFile = fs.realpathSync(absolute);
    if (afterWrite.directory !== initial.directory || path.dirname(canonicalFile) !== initial.directory || !isCanonicalPathInside(initial.workspace, canonicalFile)) {
      throw artifactPathFailure();
    }
    return { workspace: initial.workspace, absolute: canonicalFile };
  } catch (error) {
    // Remove only the inode created by this invocation. Never unlink a replaced
    // path or a symlink planted after the exclusive open.
    if (openedStat) {
      try {
        const current = fs.lstatSync(absolute);
        if (!current.isSymbolicLink() && sameFilesystemEntry(openedStat, current)) fs.unlinkSync(absolute);
      } catch { /* best-effort cleanup without exposing filesystem details */ }
    }
    throw sanitizedArtifactStorageError(error);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* do not leak descriptor errors */ }
    }
  }
}

function saveScreenshotArtifact(workspaceRoot: string, value: unknown): Record<string, unknown> {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const dataUrl = typeof row.dataUrl === 'string' ? row.dataUrl : '';
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new AdapterError('internal', 'Browser screenshot returned invalid image data.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BROWSER_IMAGE_BYTES) throw new AdapterError('payload_too_large', 'Browser screenshot exceeded the artifact limit.');
  const extension = match[1] === 'jpeg' ? 'jpg' : 'png';
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${extension}`;
  const stored = writeScreenshotFile(workspaceRoot, filename, bytes);
  const relative = path.relative(stored.workspace, stored.absolute).split(path.sep).join('/');
  if (!relative.startsWith('.brainrouter/browser/screenshots/') || path.isAbsolute(relative)) throw artifactPathFailure();
  return {
    path: relative,
    width: typeof row.width === 'number' ? row.width : undefined,
    height: typeof row.height === 'number' ? row.height : undefined,
    fullPage: row.fullPage === true,
    mimeType: match[1] === 'jpeg' ? 'image/jpeg' : 'image/png',
  };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AdapterError('aborted', 'Browser wait was aborted.');
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); cleanup(); reject(new AdapterError('aborted', 'Browser wait was aborted.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryableWaitFailure(result: BrowserCommandResult): boolean {
  return !result.ok && ['REF_NOT_FOUND', 'NOT_READY', 'TIMEOUT'].includes(result.code);
}

function stableNetworkSignature(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.map((entry) => {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    // `at` is intentionally excluded: the manager derives it from Date.now()
    // when reading PerformanceResourceTiming and it is not stable across polls.
    return [row.url, row.method, row.status, row.kind, row.durationMs, row.transferBytes];
  }));
}

async function pageTextMatches(
  manager: BrowserManagerPort,
  requestId: string,
  tabId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ matched: boolean; failure?: BrowserCommandResult }> {
  if (!text) return { matched: true };
  const found = await manager.execute({
    version: BROWSER_PROTOCOL_VERSION,
    id: requestId,
    tabId,
    command: { op: 'find', text, forward: true, findNext: false },
  }, signal);
  if (!found.ok) return { matched: false, failure: found };
  const row = found.value && typeof found.value === 'object' ? found.value as { matches?: unknown } : {};
  const matched = Number(row.matches ?? 0) > 0;
  // Find-in-page sees normal rendered body text, unlike the semantic interaction
  // snapshot. Clear its temporary selection so a read-only wait leaves no UI.
  const cleared = await manager.execute({
    version: BROWSER_PROTOCOL_VERSION,
    id: requestId,
    tabId,
    command: { op: 'stop-find', action: 'clearSelection' },
  }, signal);
  if (!cleared.ok && cleared.code === 'CANCELLED') return { matched: false, failure: cleared };
  return { matched };
}

async function targetIsVisible(
  manager: BrowserManagerPort,
  requestId: string,
  command: Pick<Extract<BrowserControlCommand, { kind: 'page.wait' | 'page.assertVisible' }>, 'tabId' | 'ref' | 'testId' | 'pageRevision'>,
  signal?: AbortSignal,
): Promise<BrowserCommandResult> {
  return manager.execute({
    version: BROWSER_PROTOCOL_VERSION,
    id: requestId,
    tabId: command.tabId,
    expectedRevision: command.pageRevision,
    command: { op: 'assert-visible', ref: command.ref, target: command.testId },
  }, signal);
}

async function waitForPage(manager: BrowserManagerPort, requestId: string, command: Extract<BrowserControlCommand, { kind: 'page.wait' }>, signal?: AbortSignal): Promise<BrowserControlResult> {
  const startedAt = Date.now();
  const timeout = Math.min(60_000, Math.max(1, command.timeoutMs ?? 15_000));
  const deadline = startedAt + timeout;
  let networkSignature: string | undefined;
  let networkStableSince = 0;
  while (Date.now() <= deadline) {
    if (signal?.aborted) return failure(command.kind, startedAt, 'aborted', 'Browser wait was aborted.', command.tabId);
    const state = manager.getState();
    const tab = state.tabs.find((entry) => entry.id === (command.tabId ?? state.activeTabId));
    if (!tab) return failure(command.kind, startedAt, 'not_found', 'Browser tab was not found.', command.tabId);

    let ready = true;
    if (command.loadState === 'load') ready = !tab.loading;
    if (command.loadState === 'domcontentloaded') {
      // A successful isolated-world read proves the target document has an
      // executable DOM; this intentionally does not wait for subresources.
      const probe = await manager.execute({
        version: BROWSER_PROTOCOL_VERSION,
        id: requestId,
        tabId: tab.id,
        command: { op: 'network' },
      }, signal);
      if (!probe.ok) {
        if (!retryableWaitFailure(probe)) return adaptManagerResult(command.kind, startedAt, probe);
        ready = false;
      }
    }
    if (command.loadState === 'networkidle') {
      if (tab.loading) {
        ready = false;
        networkSignature = undefined;
        networkStableSince = 0;
      } else {
        const probe = await manager.execute({
          version: BROWSER_PROTOCOL_VERSION,
          id: requestId,
          tabId: tab.id,
          command: { op: 'network' },
        }, signal);
        if (!probe.ok) {
          if (!retryableWaitFailure(probe)) return adaptManagerResult(command.kind, startedAt, probe);
          ready = false;
        } else {
          const signature = stableNetworkSignature(probe.value);
          if (signature !== networkSignature) {
            networkSignature = signature;
            networkStableSince = Date.now();
          }
          ready = Date.now() - networkStableSince >= 500;
        }
      }
    }
    if (command.urlIncludes) ready = ready && tab.url.includes(command.urlIncludes);
    if (ready && command.text !== undefined) {
      const textMatch = await pageTextMatches(manager, requestId, tab.id, command.text, signal);
      if (textMatch.failure) {
        if (!retryableWaitFailure(textMatch.failure)) return adaptManagerResult(command.kind, startedAt, textMatch.failure);
        ready = false;
      } else {
        ready = textMatch.matched;
      }
    }
    if (ready && (command.ref || command.testId)) {
      const target = await targetIsVisible(manager, requestId, { ...command, tabId: tab.id }, signal);
      if (!target.ok) {
        if (!retryableWaitFailure(target)) return adaptManagerResult(command.kind, startedAt, target);
        ready = false;
      }
    }
    if (ready) return success(command.kind, startedAt, { matched: true, url: tab.url }, tab.id, tab.revision);
    try { await delay(command.loadState === 'networkidle' ? 100 : 75, signal); }
    catch (error) { return failure(command.kind, startedAt, 'aborted', error instanceof Error ? error.message : String(error), tab.id, tab.revision); }
  }
  return failure(command.kind, startedAt, 'timeout', `Timed out after ${timeout} ms waiting for the page.`, command.tabId);
}

async function waitForVisible(manager: BrowserManagerPort, requestId: string, command: Extract<BrowserControlCommand, { kind: 'page.assertVisible' }>, signal?: AbortSignal): Promise<BrowserControlResult> {
  const startedAt = Date.now();
  const timeout = Math.min(60_000, Math.max(1, command.timeoutMs ?? 15_000));
  const deadline = startedAt + timeout;
  while (Date.now() <= deadline) {
    if (signal?.aborted) return failure(command.kind, startedAt, 'aborted', 'Browser visibility wait was aborted.', command.tabId);
    const result = await targetIsVisible(manager, requestId, command, signal);
    if (result.ok) return success(command.kind, startedAt, { visible: true }, result.tabId, result.revision);
    if (!retryableWaitFailure(result)) return adaptManagerResult(command.kind, startedAt, result);
    try { await delay(75, signal); }
    catch (error) { return failure(command.kind, startedAt, 'aborted', error instanceof Error ? error.message : String(error), result.tabId, result.revision); }
  }
  return failure(command.kind, startedAt, 'timeout', `Timed out after ${timeout} ms waiting for the element to become visible.`, command.tabId, command.pageRevision);
}

function snapshotWithinLimit(value: unknown, requestedMaxChars: number | undefined): unknown {
  if (requestedMaxChars === undefined) return value;
  const maxChars = Math.min(50_000, Math.max(1_000, Math.floor(requestedMaxChars)));
  const encoded = JSON.stringify(value);
  if (encoded.length <= maxChars) return value;

  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  if (nodes.length > 0 || 'nodes' in row) {
    // Keep the semantic response structurally usable: refs in every retained
    // node remain valid, and callers can see exactly how many nodes were omitted.
    let url = typeof row.url === 'string' ? row.url : '';
    let title = typeof row.title === 'string' ? row.title : '';
    const make = (count: number) => ({
      url,
      title,
      nodes: nodes.slice(0, count),
      truncated: true,
      omittedNodes: nodes.length - count,
    });
    while (JSON.stringify(make(0)).length > maxChars && (url.length > 32 || title.length > 32)) {
      url = url.slice(0, Math.max(32, Math.floor(url.length * 0.75)));
      title = title.slice(0, Math.max(32, Math.floor(title.length * 0.75)));
    }
    let low = 0;
    let high = nodes.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(make(middle)).length <= maxChars) low = middle;
      else high = middle - 1;
    }
    const bounded = make(low);
    if (JSON.stringify(bounded).length <= maxChars) return bounded;
  }

  const omittedChars = encoded.length;
  const empty = { truncated: true, preview: '', omittedChars };
  const previewLength = Math.max(0, maxChars - JSON.stringify(empty).length);
  return { truncated: true, preview: encoded.slice(0, previewLength), omittedChars: Math.max(0, encoded.length - previewLength) };
}

type ObservationChannel = 'console' | 'network' | 'downloads';
interface TrackedObservation { key: string; sequence: number; value: unknown }
interface ObservationChannelState { nextSequence: number; rows: TrackedObservation[] }
interface ObservationTracker { namespace: string; channels: Map<string, ObservationChannelState> }

const observationTrackers = new WeakMap<BrowserManagerPort, ObservationTracker>();

function observationTracker(manager: BrowserManagerPort): ObservationTracker {
  let tracker = observationTrackers.get(manager);
  if (!tracker) {
    tracker = { namespace: randomUUID().replace(/-/g, '').slice(0, 10), channels: new Map() };
    observationTrackers.set(manager, tracker);
  }
  return tracker;
}

function observationKey(channel: ObservationChannel, value: unknown): string {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (channel === 'downloads') return String(row.id ?? '');
  if (channel === 'network') {
    return JSON.stringify([row.url, row.method, row.status, row.kind, row.durationMs, row.transferBytes]);
  }
  return JSON.stringify([row.level, row.text, row.source, row.line, row.at]);
}

function scopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 12);
}

function cursorFor(tracker: ObservationTracker, channel: ObservationChannel, scope: string, sequence: number): string {
  return `br1:${channel}:${tracker.namespace}:${scopeHash(scope)}:${sequence}`;
}

function cursorSequence(tracker: ObservationTracker, channel: ObservationChannel, scope: string, cursor: string): number {
  const match = /^br1:(console|network|downloads):([a-f0-9]{10}):([a-f0-9]{12}):(\d+)$/.exec(cursor);
  if (!match || match[1] !== channel || match[2] !== tracker.namespace || match[3] !== scopeHash(scope)) {
    throw new AdapterError('invalid_request', `The ${channel} cursor is invalid for this browser tab.`);
  }
  const sequence = Number(match[4]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new AdapterError('invalid_request', `The ${channel} cursor is invalid.`);
  return sequence;
}

function trackObservationRows(
  tracker: ObservationTracker,
  channel: ObservationChannel,
  scope: string,
  values: unknown[],
): ObservationChannelState {
  const key = `${channel}\n${scope}`;
  const state = tracker.channels.get(key) ?? { nextSequence: 0, rows: [] };
  const incomingKeys = values.map((value) => observationKey(channel, value));
  let overlap = Math.min(state.rows.length, incomingKeys.length);
  while (overlap > 0) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (state.rows[state.rows.length - overlap + index].key !== incomingKeys[index]) {
        matches = false;
        break;
      }
    }
    if (matches) break;
    overlap -= 1;
  }

  const nextRows: TrackedObservation[] = [];
  for (let index = 0; index < overlap; index += 1) {
    const previous = state.rows[state.rows.length - overlap + index];
    nextRows.push({ key: incomingKeys[index], sequence: previous.sequence, value: values[index] });
  }
  for (let index = overlap; index < values.length; index += 1) {
    state.nextSequence += 1;
    nextRows.push({ key: incomingKeys[index], sequence: state.nextSequence, value: values[index] });
  }
  state.rows = nextRows;
  tracker.channels.set(key, state);
  return state;
}

function paginateObservations(
  manager: BrowserManagerPort,
  channel: ObservationChannel,
  scope: string,
  values: unknown[],
  after: string | undefined,
  requestedLimit: number | undefined,
): Record<string, unknown> {
  const tracker = observationTracker(manager);
  const state = trackObservationRows(tracker, channel, scope, values);
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit ?? 100)));
  const afterSequence = after ? cursorSequence(tracker, channel, scope, after) : undefined;
  if (afterSequence !== undefined && afterSequence > state.nextSequence) {
    throw new AdapterError('invalid_request', `The ${channel} cursor is expired or belongs to another browser session.`);
  }
  const candidates = afterSequence === undefined
    ? state.rows.slice(Math.max(0, state.rows.length - limit))
    : state.rows.filter((entry) => entry.sequence > afterSequence);
  const selected = candidates.slice(0, limit);
  const firstAvailable = state.rows[0]?.sequence;
  const nextCursor = selected.length > 0
    ? cursorFor(tracker, channel, scope, selected[selected.length - 1].sequence)
    : after ?? null;
  return {
    entries: selected.map((entry) => entry.value),
    nextCursor,
    hasMore: candidates.length > selected.length,
    ...(afterSequence !== undefined && firstAvailable !== undefined && afterSequence < firstAvailable - 1 ? { droppedBefore: true } : {}),
  };
}

async function executePreparedTargetCommand(
  manager: BrowserManagerPort,
  requestId: string,
  kind: string,
  mapped: MappedAgentBrowserCommand,
  startedAt: number,
  signal?: AbortSignal,
): Promise<BrowserControlResult> {
  const preparation = mapped.targetPreparation!;
  const prepareCommand: BrowserCommand = preparation.kind === 'focus'
    ? { op: 'type', ref: preparation.ref, target: preparation.target, text: '', replace: false }
    : { op: 'hover', ref: preparation.ref, target: preparation.target };
  const prepared = await manager.execute({
    version: BROWSER_PROTOCOL_VERSION,
    id: requestId,
    tabId: mapped.tabId,
    expectedRevision: mapped.expectedRevision,
    command: prepareCommand,
  }, signal);
  if (!prepared.ok) return adaptManagerResult(kind, startedAt, prepared);

  let command = mapped.command;
  if (preparation.kind === 'pointer') {
    const row = prepared.value && typeof prepared.value === 'object' ? prepared.value as Record<string, unknown> : {};
    const x = Number(row.x);
    const y = Number(row.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || command.op !== 'scroll') {
      return failure(kind, startedAt, 'internal', 'Browser could not resolve the scroll target.', prepared.tabId, prepared.revision);
    }
    command = { ...command, x, y };
  }
  const result = await manager.execute({
    version: BROWSER_PROTOCOL_VERSION,
    id: requestId,
    tabId: prepared.tabId,
    expectedRevision: prepared.revision,
    command,
  }, signal);
  return adaptManagerResult(kind, startedAt, result);
}

export async function executeAgentBrowserCommand(
  manager: BrowserManagerPort,
  request: AgentBrowserRequest,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<BrowserControlResult> {
  const startedAt = Date.now();
  const kind = request.command.kind;
  try {
    const state = manager.getState();
    if (kind === 'capabilities') {
      return success(kind, startedAt, {
        protocolVersion: 1, tabs: true, semanticSnapshot: true, screenshot: true,
        console: true, network: true, downloads: true, dialogs: true, permissions: true,
        interactions: ['click', 'doubleClick', 'hover', 'type', 'press', 'scroll', 'drag', 'select', 'check', 'setFiles', 'assertVisible', 'setDevice'],
      }, state.activeTabId, state.tabs.find((tab) => tab.id === state.activeTabId)?.revision);
    }
    if (kind === 'tabs.list') return success(kind, startedAt, { tabs: state.tabs.map((tab) => tabSummary(tab, state.activeTabId)) }, state.activeTabId, state.tabs.find((tab) => tab.id === state.activeTabId)?.revision);
    if (request.command.kind === 'page.state') {
      const targetTabId = request.command.tabId;
      const tab = state.tabs.find((entry) => entry.id === (targetTabId ?? state.activeTabId));
      if (!tab) return failure(kind, startedAt, 'not_found', 'Browser tab was not found.', targetTabId);
      return success(kind, startedAt, { tab: tabSummary(tab, state.activeTabId), surface: state.surface }, tab.id, tab.revision);
    }
    if (kind === 'page.wait') return waitForPage(manager, request.id, request.command, signal);
    if (kind === 'permission.respond') {
      const prompt = state.permissionPrompt;
      if (!prompt || prompt.origin !== request.command.origin || prompt.permission !== request.command.permission) return failure(kind, startedAt, 'not_found', 'Matching permission prompt was not found.');
      const result = await manager.execute({ version: BROWSER_PROTOCOL_VERSION, id: request.id, tabId: prompt.tabId, command: { op: 'respond-permission', promptId: prompt.id, allow: request.command.decision === 'allow' } }, signal);
      return adaptManagerResult(kind, startedAt, result);
    }
    if (kind === 'dialog.respond') {
      const prompt = state.dialogPrompt;
      if (!prompt || (request.command.tabId && prompt.tabId !== request.command.tabId)) return failure(kind, startedAt, 'not_found', 'No matching browser dialog is waiting.', request.command.tabId);
      // ADR-055 P11 (D6) — a certificate trust decision is the human's, never the
      // agent's; the agent may dismiss a certificate dialog but not accept one.
      if (prompt.kind === 'certificate' && request.command.action === 'accept') {
        return failure(kind, startedAt, 'permission_denied', 'Certificate trust decisions are for a human. Ask the person to accept or reject it in the visible Browser tab.', prompt.tabId);
      }
      const result = await manager.execute({ version: BROWSER_PROTOCOL_VERSION, id: request.id, tabId: prompt.tabId, command: { op: 'respond-dialog', promptId: prompt.id, accept: request.command.action === 'accept', value: request.command.promptText } }, signal);
      return adaptManagerResult(kind, startedAt, result);
    }
    const mapped = mapAgentBrowserCommand(request.command);
    const result = await manager.execute({ version: BROWSER_PROTOCOL_VERSION, id: request.id, tabId: mapped.tabId, expectedRevision: mapped.expectedRevision, command: mapped.command }, signal);
    if (result.ok && kind === 'tabs.open') {
      const opened = result.value && typeof result.value === 'object'
        ? result.value as { id?: unknown; revision?: unknown }
        : {};
      const openedTabId = typeof opened.id === 'string' ? opened.id : result.tabId;
      const openedRevision = Number.isSafeInteger(opened.revision)
        ? Number(opened.revision)
        : result.revision;
      return success(kind, startedAt, result.value, openedTabId, openedRevision);
    }
    if (result.ok && kind === 'page.screenshot') {
      return success(kind, startedAt, saveScreenshotArtifact(workspaceRoot, result.value), result.tabId, result.revision);
    }
    if (result.ok && kind === 'page.setFiles') {
      const row = result.value && typeof result.value === 'object' ? result.value as { accepted?: unknown; fileCount?: unknown } : {};
      return success(kind, startedAt, {
        accepted: row.accepted === true,
        fileCount: Number.isSafeInteger(row.fileCount) ? Math.max(0, Math.min(20, Number(row.fileCount))) : 0,
      }, result.tabId, result.revision);
    }
    if (result.ok && kind === 'page.downloads') {
      const rows = Array.isArray(result.value) ? result.value : [];
      const safeRows = rows.slice(-500).map((entry) => {
        const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        return {
          id: row.id,
          tabId: row.tabId,
          filename: row.filename,
          url: row.url,
          receivedBytes: row.receivedBytes,
          totalBytes: row.totalBytes,
          state: row.state,
          startedAt: row.startedAt,
          saved: typeof row.savePath === 'string' && row.savePath.length > 0,
        };
      });
      return success(kind, startedAt, safeRows, result.tabId, result.revision);
    }
    let adapted = adaptManagerResult(kind, startedAt, result);
    if (adapted.ok && ['page.console', 'page.network', 'page.downloads'].includes(kind)) {
      const limit = Math.max(1, Math.min(500, Number((request.command as { limit?: number }).limit ?? 100)));
      const rows = Array.isArray(adapted.data) ? adapted.data.slice(-limit) : adapted.data;
      adapted = { ...adapted, data: rows };
    }
    return adapted;
  } catch (error) {
    const code = error instanceof AdapterError ? error.code : signal?.aborted ? 'aborted' : 'internal';
    return failure(kind, startedAt, code, error instanceof Error ? error.message : String(error));
  }
}

function adaptManagerResult(kind: string, startedAt: number, result: BrowserCommandResult): BrowserControlResult {
  if (result.ok) return success(kind, startedAt, result.value, result.tabId, result.revision);
  return failure(kind, startedAt, coreError(result.code), result.error, result.tabId, result.revision);
}
