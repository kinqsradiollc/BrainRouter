import {
  app,
  Menu,
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type DownloadItem,
  type Input,
  type Session,
  type WebContents,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedWebviewSrc, isMetadataOrLinkLocalAddress, isPrivateOrLocalAddress } from '../webviewPolicy.js';
import { browserPermissionCheckScopes, browserPermissionRequestScope } from './browserPermissionPolicy.js';
import { agentCursorScript, removeAgentCursorScript } from './browserCursor.js';
import { humanChallengeReason } from './browserHumanChallenge.js';
import {
  browserAcceptLanguages,
  browserPartitionForWorkspace,
  standardChromeUserAgent,
} from './browserProfile.js';
import { promptForHttpAuth } from './httpAuthPrompt.js';
import {
  BROWSER_BLANK_URL,
  BROWSER_PROTOCOL_VERSION,
  MAX_BROWSER_IMAGE_BYTES,
  MAX_BROWSER_ROWS,
  MAX_BROWSER_TABS,
  boundBrowserArray,
  boundBrowserText,
  clampBrowserSurface,
  isBrowserCommandRequest,
  isOpaqueBrowserRef,
  normalizeBrowserAddress,
  redactBrowserValue,
  type BrowserCommand,
  type BrowserCommandRequest,
  type BrowserCommandResult,
  type BrowserConsoleEntry,
  type BrowserDownload,
  type BrowserErrorCode,
  type BrowserEvent,
  type BrowserNetworkEntry,
  type BrowserSemanticNode,
  type BrowserState,
  type BrowserSurface,
  type BrowserTab,
  type BrowserTabId,
} from './protocol.js';

const ISOLATED_WORLD_ID = 1_001;
const MAX_CONSOLE_ROWS = 300;
const MAX_NETWORK_ROWS = 500;
const PERMISSION_TIMEOUT_MS = 30_000;
const DIALOG_TIMEOUT_MS = 60_000;
const AGENT_DOWNLOAD_GESTURE_MS = 5_000;
const MAX_STAGED_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;
const MAX_STAGED_UPLOAD_TOTAL_BYTES = 1024 * 1024 * 1024;
const STAGED_UPLOAD_TTL_MS = 30 * 60_000;
const AGENT_DOWNLOAD_INTERACTIONS = new Set<BrowserCommand['op']>([
  'click', 'double-click', 'type', 'press', 'drag', 'select', 'check', 'set-files', 'respond-dialog',
]);

class BrowserManagerError extends Error {
  constructor(public readonly code: BrowserErrorCode, message: string) {
    super(message);
  }
}

type ViewRecord = {
  view: WebContentsView;
  console: BrowserConsoleEntry[];
};

type ClosedTab = { url: string; title: string };
type PendingPermission = {
  id: string;
  tabId: BrowserTabId;
  respond: (allow: boolean) => void;
  cancel: () => void;
  timer: ReturnType<typeof setTimeout>;
};
type DialogResponse = { accept: boolean; value?: string };
type PendingDialog = {
  id: string;
  tabId: BrowserTabId;
  finish: (response: DialogResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PersistedPermissionDecision = {
  origin: string;
  permission: 'geolocation';
  decision: 'allow' | 'block';
};
type PersistedTabs = {
  version: 1;
  activeIndex: number;
  tabs: Array<{ url: string }>;
  permissions?: PersistedPermissionDecision[];
};
type AgentNavigationPolicy = { allowedPrivateOrigin?: string };
type StagedUpload = { directory: string; timer: ReturnType<typeof setTimeout> };
type BrowserOperationGuard = () => void;

const managersByWebContents = new Map<number, BrowserViewManager>();
const configuredSessions = new WeakSet<Session>();
type BrowserHostResolver = (host: string, fresh: boolean) => Promise<string[]>;

async function resolvedDestinationAllowed(rawUrl: string, agentPolicy?: { allowedPrivateOrigin?: string }, resolver?: BrowserHostResolver): Promise<boolean> {
  let host = '';
  let origin = '';
  try {
    const url = new URL(rawUrl);
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    origin = url.origin;
  }
  catch { return false; }
  if (!host) return false;
  const privateAllowed = Boolean(agentPolicy?.allowedPrivateOrigin && agentPolicy.allowedPrivateOrigin === origin);
  if (host === 'localhost' || host.endsWith('.localhost')) return !agentPolicy || privateAllowed;
  if (isIP(host)) return !isMetadataOrLinkLocalAddress(host) && (!agentPolicy || !isPrivateOrLocalAddress(host) || privateAllowed);
  let allow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolver
        ? resolver(host, Boolean(agentPolicy)).then((rows) => rows.map((address) => ({ address })))
        : lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS resolution timed out.')), 2_000); }),
    ]);
    allow = addresses.length > 0 && addresses.every((entry) => !isMetadataOrLinkLocalAddress(entry.address)
      && (!agentPolicy || !isPrivateOrLocalAddress(entry.address) || privateAllowed));
  } catch {
    // If the preflight resolver cannot establish a safe destination, fail
    // closed. Chromium will show a normal load failure on a subsequent retry
    // once DNS is healthy rather than risking cloud-metadata credential access.
    allow = false;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return allow;
}

function configureBrowserSession(ses: Session): void {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setUserAgent(
    standardChromeUserAgent(),
    browserAcceptLanguages(app.getLocale()),
  );
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!contents) return false;
    return managersByWebContents.get(contents.id)?.hasPermission(origin, browserPermissionCheckScopes(permission, details.mediaType)) ?? false;
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const manager = managersByWebContents.get(contents.id);
    if (!manager) { callback(false); return; }
    const mediaTypes = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const scope = browserPermissionRequestScope(permission, mediaTypes);
    if (!scope) { callback(false); return; }
    manager.requestPermission(contents.id, scope.promptPermission, scope.grants, details.requestingUrl || contents.getURL(), callback);
  });
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!details.webContentsId || !managersByWebContents.has(details.webContentsId)) {
      callback({});
      return;
    }
    const manager = managersByWebContents.get(details.webContentsId);
    if (!manager?.shouldValidateDestinationRequest(details.webContentsId, details.resourceType)) {
      callback({});
      return;
    }
    void (manager?.destinationAllowedForRequest(details.webContentsId, details.url) ?? resolvedDestinationAllowed(details.url))
      .then((allow) => callback({ cancel: !allow }), () => callback({ cancel: true }));
  });
}

function initialTab(id: string, url: string, title = 'New tab', now = Date.now()): BrowserTab {
  return {
    id,
    url,
    title: boundBrowserText(title || 'New tab', 256),
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    audible: false,
    muted: false,
    zoomFactor: 1,
    revision: 0,
    lastAccessedAt: now,
  };
}

function safeDownloadName(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f]/g, '').trim();
  return boundBrowserText(base || 'download', 180);
}

function availableDownloadPath(directory: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(directory, filename);
  for (let n = 1; fs.existsSync(candidate) && n < 10_000; n += 1) {
    candidate = path.join(directory, `${stem} (${n})${ext}`);
  }
  return candidate;
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

function persistableBrowserUrl(raw: string): string {
  if (!raw || raw.startsWith('data:')) return BROWSER_BLANK_URL;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    // BrainRouter owns only restorable tab locations, never page content or
    // credentials. Query strings/fragments commonly contain searches, document
    // text, OAuth/SAML assertions, invite tokens, and one-time codes under
    // arbitrary key names, so persistence deliberately keeps origin + path only.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return BROWSER_BLANK_URL;
  }
}

function targetScript(tabId: string, revision: number, ref?: string, target?: string, label?: string, targetType?: string): string {
  return `(() => {
    const store = window.__brainrouterAgentRefs;
    let el = null;
    const ref = ${JSON.stringify(ref ?? '')};
    if (ref && store && store.revision === ${revision}) el = store.nodes.get(ref) || null;
    const target = ${JSON.stringify(boundBrowserText(target, 512))};
    const label = ${JSON.stringify(boundBrowserText(label, 512).toLowerCase())};
    const wantedType = ${JSON.stringify(boundBrowserText(targetType, 64).toLowerCase())};
    const visible = (node) => { const r=node.getBoundingClientRect(); const s=getComputedStyle(node); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
    if (!el && target) {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(target) : target.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      el = document.querySelector('[data-testid="'+escaped+'"]') || document.getElementById(target);
    }
    if (!el && (target || label)) {
      const wanted = (label || target).toLowerCase();
      const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[data-testid]')).slice(0, 2000);
      el = candidates.find((node) => {
        if (!visible(node)) return false;
        const tag=(node.tagName||'').toLowerCase(), role=(node.getAttribute('role')||'').toLowerCase();
        if (wantedType && ![tag,role,node.getAttribute('type')||''].includes(wantedType)) return false;
        const text=String(node.getAttribute('aria-label')||node.getAttribute('title')||node.getAttribute('placeholder')||node.textContent||'').trim().toLowerCase();
        return text===wanted || text.includes(wanted);
      }) || null;
    }
    if (!el || !el.isConnected) return { ok:false, error:'Element reference was not found.', tabId:${JSON.stringify(tabId)}, revision:${revision} };
    const rect=el.getBoundingClientRect();
    return { ok:true, visible:visible(el), rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, tag:(el.tagName||'').toLowerCase() };
  })()`;
}

function semanticSnapshotScript(tabId: string, revision: number): string {
  return `(() => {
    const roleFor = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox',NAV:'navigation',MAIN:'main',HEADER:'banner',FOOTER:'contentinfo',H1:'heading',H2:'heading',H3:'heading',IMG:'img'})[el.tagName] || '';
    const visible = (el) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth && s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity||1)>0; };
    const nameFor = (el) => String(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,200);
    const valueIsSensitive = (el,type) => {
      if (['password','hidden','file'].includes(type)) return true;
      const autocomplete=String(el.getAttribute('autocomplete')||'').toLowerCase();
      if (/(?:current|new)-password|cc-(?:number|csc|exp)|one-time-code/.test(autocomplete)) return true;
      const identity=String([el.id,el.getAttribute('name'),el.getAttribute('data-testid'),el.getAttribute('aria-label')].filter(Boolean).join(' ')).toLowerCase();
      return /(?:^|[^a-z])(password|passwd|secret|token|csrf|xsrf|session|authorization|api.?key|card.?number|credit.?card|cvv|cvc|csc|otp)(?:[^a-z]|$)/.test(identity);
    };
    const nodes = new Map(); const rows=[];
    const all=Array.from(document.querySelectorAll('a,button,input,textarea,select,option,summary,nav,main,header,footer,[role],[data-testid],h1,h2,h3,img')).slice(0,2500);
    let index=0;
    for (const el of all) {
      const isVisible=visible(el), role=roleFor(el), testid=el.getAttribute('data-testid')||'';
      if (!role && !testid) continue;
      // The model controls the exact visible page, so hidden DOM content is not
      // an observation surface. This also prevents hidden data-testid, ARIA,
      // title, placeholder, and text nodes from disclosing application secrets.
      if (!isVisible) continue;
      const ref='br:${tabId}:${revision}:node_'+(++index); nodes.set(ref,el);
      const r=el.getBoundingClientRect(), type=String(el.getAttribute('type')||'').slice(0,40);
      const valueBearing=isVisible&&(el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement||(el instanceof HTMLInputElement&&['','text','search','email','url','tel','number','range','date','time','month','week','datetime-local','color'].includes(type)));
      rows.push({ref,role,name:nameFor(el),tag:(el.tagName||'').toLowerCase(),testid:testid||undefined,type:type||undefined,
        value:!valueBearing||valueIsSensitive(el,type)?undefined:String(el.value||'').slice(0,200),
        checked:typeof el.checked==='boolean'?el.checked:undefined,selected:typeof el.selected==='boolean'?el.selected:undefined,
        disabled:typeof el.disabled==='boolean'?el.disabled:undefined,visible:isVisible,rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
      if(rows.length>=${MAX_BROWSER_ROWS}) break;
    }
    window.__brainrouterAgentRefs={revision:${revision},nodes};
    return {url:location.href,title:document.title,nodes:rows};
  })()`;
}

function performanceNetworkScript(): string {
  return `(() => performance.getEntriesByType('resource').slice(-${MAX_NETWORK_ROWS}).map((entry) => ({
    url:String(entry.name||'').slice(0,4096), method:'GET', status:Number(entry.responseStatus||0),
    kind:String(entry.initiatorType||'resource').slice(0,64), durationMs:Math.round(Number(entry.duration||0)),
    transferBytes:Number(entry.transferSize||0), at:Date.now()-Math.round(Number(entry.duration||0))
  })))()`;
}

export class BrowserViewManager {
  private workspaceRoot: string;
  private readonly records = new Map<BrowserTabId, ViewRecord>();
  private tabs: BrowserTab[] = [];
  private activeTabId = '';
  private closedTabs: ClosedTab[] = [];
  private downloads: BrowserDownload[] = [];
  private readonly downloadItems = new Map<string, DownloadItem>();
  private readonly downloadWorkspaces = new Map<string, string>();
  private surface: BrowserSurface = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private tabSequence = 0;
  private downloadSequence = 0;
  private permissionSequence = 0;
  private dialogSequence = 0;
  private readonly windowPrefix = randomUUID().replace(/-/g, '').slice(0, 10);
  // One persistent profile per workspace preserves sign-ins, cookies, storage,
  // and completed site challenges across chat sessions without sharing them
  // with another workspace.
  private partition: string;
  // The tab whose native view is currently a child of the window. Re-adding an
  // already-attached view flashes it, so attachActiveView only add/removes on a
  // real change and otherwise just re-bounds (smooth).
  private attachedViewId: BrowserTabId | null = null;
  private sessionKey: string | null = null;
  private readonly queues = new Map<BrowserTabId, Promise<void>>();
  private readonly emulatedTabs = new Set<BrowserTabId>();
  // When true, agent pointer actions (click/hover/drag) glide a visible cursor
  // overlay to the target and pulse a ripple on click, so a human watching the
  // pane SEES the agent operate the page. Toggled by the panel's set-cursor op;
  // defaults on so the cursor shows even before the renderer syncs the toggle.
  private agentCursorEnabled = true;
  private permissionPrompt: BrowserState['permissionPrompt'] = null;
  private dialogPrompt: BrowserState['dialogPrompt'] = null;
  private pendingPermission: PendingPermission | null = null;
  private pendingDialog: PendingDialog | null = null;
  private readonly permissionGrants = new Set<string>();
  private readonly permissionDecisions = new Map<string, PersistedPermissionDecision['decision']>();
  private visibleAgentPin: {
    tabId: BrowserTabId;
    deferredSelection?: BrowserTabId;
    deferredSurface?: BrowserSurface;
    userTakeoverRequested?: boolean;
  } | null = null;
  private agentTakeoverHandler: (() => void) | null = null;
  private readonly agentNavigationPolicies = new Map<BrowserTabId, AgentNavigationPolicy>();
  private readonly agentControlledTabs = new Set<BrowserTabId>();
  private readonly humanChallengeTabs = new Set<BrowserTabId>();
  private readonly trustedUserPrivateOrigins = new Set<string>();
  private readonly userOriginChecks = new Map<string, Promise<void>>();
  private readonly agentDownloadAllowances = new Map<BrowserTabId, number>();
  private readonly syntheticInputUntil = new Map<BrowserTabId, number>();
  private readonly stagedUploads = new Map<BrowserTabId, StagedUpload>();
  private readonly pendingAuthPrompts = new Map<BrowserTabId, AbortController>();
  private readonly rawSettlements = new Map<string, Promise<void>>();
  private downloadListener: ((event: Electron.Event, item: DownloadItem, contents: WebContents) => void) | null = null;
  private stateEmitQueued = false;
  private disposed = false;
  private workspaceGeneration = 0;

  constructor(private readonly win: BrowserWindow, workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.partition = browserPartitionForWorkspace(workspaceRoot);
    configureBrowserSession(session.fromPartition(this.partition));
    this.restoreWorkspace();
    if (this.tabs.length === 0) this.createTab(BROWSER_BLANK_URL, true);
    this.installDownloadListener();
  }

  getState(): BrowserState {
    return {
      version: BROWSER_PROTOCOL_VERSION,
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => ({ ...tab })),
      closedTabCount: this.closedTabs.length,
      surface: { ...this.surface },
      downloads: this.workspaceDownloads(),
      permissionPrompt: this.permissionPrompt ? { ...this.permissionPrompt } : null,
      dialogPrompt: this.dialogPrompt ? { ...this.dialogPrompt } : null,
      capabilities: {
        nativeTabs: true,
        sameVisibleTabAutomation: true,
        downloads: true,
        permissions: true,
        semanticSnapshot: true,
        maxTabs: MAX_BROWSER_TABS,
      },
    };
  }

  setAgentTakeoverHandler(handler: (() => void) | null): void {
    this.agentTakeoverHandler = handler;
  }

  setSurface(raw: unknown): BrowserSurface {
    if (!raw || typeof raw !== 'object') throw new BrowserManagerError('INVALID_REQUEST', 'Browser surface is invalid.');
    const value = raw as Partial<BrowserSurface>;
    const bounds = this.win.getContentBounds();
    const next = clampBrowserSurface({
      x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height), visible: value.visible === true,
    }, bounds);
    if (this.visibleAgentPin && (!next.visible || next.width <= 1 || next.height <= 1)) {
      // A panel switch/unmount is explicit user takeover. Abort the active
      // action, but keep its exact native tab attached until the raw Chromium
      // work settles; detaching early would allow a late action on hidden UI.
      this.visibleAgentPin.deferredSurface = next;
      this.visibleAgentPin.userTakeoverRequested = true;
      this.agentTakeoverHandler?.();
      return { ...this.surface };
    }
    if (this.visibleAgentPin) this.visibleAgentPin.deferredSurface = undefined;
    this.surface = next;
    this.attachActiveView();
    this.emitState();
    return { ...this.surface };
  }

  /**
   * Keep one concrete tab attached for the duration of a visible agent action.
   * User shortcuts, popups, and page prompts may request another tab while an
   * async locator is resolving; that selection is applied immediately after
   * release instead of moving the native surface underneath the agent.
   */
  pinVisibleTab(tabId: BrowserTabId): () => void {
    if (this.visibleAgentPin) throw new BrowserManagerError('NOT_READY', 'Another visible browser action is still active.');
    this.selectTab(tabId);
    this.visibleAgentPin = { tabId };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const pin = this.visibleAgentPin;
      const deferred = pin?.deferredSelection;
      const deferredSurface = pin?.deferredSurface;
      this.visibleAgentPin = null;
      if (pin?.userTakeoverRequested) this.releaseAgentControl(pin.tabId);
      if (deferredSurface) {
        this.surface = deferredSurface;
        this.attachActiveView();
        this.emitState();
      }
      if (deferred && this.resolveTab(deferred, false)) this.selectTab(deferred);
    };
  }

  isTabVisible(tabId: BrowserTabId): boolean {
    const contents = this.records.get(tabId)?.view.webContents;
    return this.activeTabId === tabId
      && this.surface.visible
      && this.surface.width > 1
      && this.surface.height > 1
      && Boolean(contents && !contents.isDestroyed());
  }

  async destinationAllowedForRequest(contentsId: number, url: string): Promise<boolean> {
    const tab = this.tabForContents(contentsId);
    return this.destinationAllowed(url, tab ? this.agentNavigationPolicies.get(tab.id) : undefined);
  }

  shouldValidateDestinationRequest(contentsId: number, resourceType: string): boolean {
    const tab = this.tabForContents(contentsId);
    return resourceType === 'mainFrame' || Boolean(tab && this.agentNavigationPolicies.has(tab.id));
  }

  private destinationAllowed(url: string, policy?: AgentNavigationPolicy): Promise<boolean> {
    const browserSession = session.fromPartition(this.partition);
    return resolvedDestinationAllowed(url, policy, async (host, fresh) => {
      const resolved = await browserSession.resolveHost(host, { cacheUsage: fresh ? 'disallowed' : 'allowed' });
      return resolved.endpoints.map((entry) => entry.address);
    });
  }

  async executeRaw(command: BrowserCommand, tabId?: string): Promise<BrowserCommandResult> {
    return this.execute({ version: BROWSER_PROTOCOL_VERSION, id: `renderer_${randomUUID()}`, tabId, command });
  }

  async waitForRequestSettlement(requestId: string): Promise<void> {
    await (this.rawSettlements.get(requestId) ?? Promise.resolve());
  }

  async execute(request: BrowserCommandRequest, signal?: AbortSignal): Promise<BrowserCommandResult> {
    const raw: unknown = request;
    if (!isBrowserCommandRequest(raw)) {
      const invalidId = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
        ? (raw as { id: string }).id
        : 'invalid';
      return this.failure(invalidId, 'INVALID_REQUEST', 'Invalid browser command request.');
    }
    const operationGeneration = this.workspaceGeneration;
    const operation = async (): Promise<BrowserCommandResult> => {
      try {
        this.assertOperationCurrent(operationGeneration, signal, request.tabId);
        const tab = this.resolveTab(request.tabId);
        if (request.expectedRevision !== undefined && tab && request.expectedRevision !== tab.revision) {
          throw new BrowserManagerError('STALE_PAGE', `Page revision changed from ${request.expectedRevision} to ${tab.revision}. Take a new snapshot.`);
        }
        let agentNewTabPolicy: AgentNavigationPolicy | undefined;
        // A `signal` marks an AGENT-driven command (a direct renderer command has
        // none). Surface the navigation-class ones in the status/Logs so the user
        // can see what the agent is doing in the browser, not just the result.
        if (signal) {
          const c = request.command;
          const url = 'url' in c && c.url ? boundBrowserText(String(c.url), 160) : '';
          if (c.op === 'navigate' && tab) this.setStatus(tab, `🤖 Agent navigating → ${url}`);
          else if (c.op === 'create-tab') this.setStatus(this.activeTab() ?? tab, `🤖 Agent opened a tab${url ? ` → ${url}` : ''}`);
        }
        if (signal && request.command.op === 'navigate') {
          const policy = await this.resolveAgentNavigationPolicy(request.command.url);
          this.assertOperationCurrent(operationGeneration, signal, tab?.id);
          if (tab) this.agentNavigationPolicies.set(tab.id, policy);
        } else if (signal && request.command.op === 'create-tab') {
          agentNewTabPolicy = request.command.url
            ? await this.resolveAgentNavigationPolicy(request.command.url)
            : {};
          this.assertOperationCurrent(operationGeneration, signal);
        } else if (signal && tab && !this.agentNavigationPolicies.has(tab.id)) {
          this.agentNavigationPolicies.set(tab.id, await this.agentPolicyForExistingTab(tab));
          this.assertOperationCurrent(operationGeneration, signal, tab.id);
        } else if (!signal && tab && !['respond-permission', 'respond-dialog', 'stop'].includes(request.command.op)) {
          // A direct renderer command is an explicit user takeover of the tab.
          this.releaseAgentControl(tab.id);
          if (request.command.op === 'navigate') void this.recordUserPrivateOrigin(request.command.url);
        }
        if (
          signal
          && tab
          && this.humanChallengeTabs.has(tab.id)
          && !['snapshot', 'screenshot', 'state', 'stop'].includes(request.command.op)
        ) {
          this.releaseAgentControl(tab.id);
          this.selectTab(tab.id);
          throw new BrowserManagerError(
            'NOT_READY',
            'This site requires human verification. Complete it in the visible Browser tab, then ask the agent to continue.',
          );
        }
        if (signal && tab) {
          this.agentControlledTabs.add(tab.id);
          if (AGENT_DOWNLOAD_INTERACTIONS.has(request.command.op)) {
            this.agentDownloadAllowances.set(tab.id, Date.now() + AGENT_DOWNLOAD_GESTURE_MS);
          }
        }
        this.assertOperationCurrent(operationGeneration, signal, tab?.id);
        const value = await this.runCommand(request.command, tab, {
          signal,
          generation: operationGeneration,
          agentNewTabPolicy,
        });
        const current = this.resolveTab(request.command.op === 'select-tab' ? request.command.tabId : request.tabId, false) ?? this.activeTab();
        // Screenshot bytes stay intact on the renderer/utility boundary. The
        // utility adapter immediately writes them to a workspace artifact and
        // returns only its path to the model; normal observations remain deeply
        // redacted and string-bounded here.
        const clean = request.command.op === 'screenshot' ? value : redactBrowserValue(value);
        if (request.command.op !== 'screenshot' && jsonBytes(clean) > 2 * 1024 * 1024) throw new BrowserManagerError('TOO_LARGE', 'Browser result exceeded the 2 MB observation limit.');
        return { ok: true, requestId: request.id, tabId: current.id, revision: current.revision, value: clean };
      } catch (error) {
        const managerError = error instanceof BrowserManagerError ? error : new BrowserManagerError('INTERNAL', error instanceof Error ? error.message : String(error));
        const current = this.resolveTab(request.tabId, false) ?? this.resolveTab(undefined, false);
        return this.failure(request.id, managerError.code, managerError.message, current);
      }
    };
    const startBoundedOperation = (): { result: Promise<BrowserCommandResult>; settled: Promise<void> } => {
      if (signal?.aborted) {
        const current = this.resolveTab(request.tabId, false) ?? this.resolveTab(undefined, false);
        const result = Promise.resolve(this.failure(request.id, 'CANCELLED', 'Browser command was cancelled.', current));
        return { result, settled: result.then(() => undefined) };
      }
      const stop = (): void => {
        const current = this.resolveTab(request.tabId, false);
        if (!current) return;
        this.cancelPendingDialog(current.id);
        if (this.pendingPermission?.tabId === current.id) this.respondPermission(this.pendingPermission.id, false);
        try { this.requireContents(current.id).stop(); } catch { /* already closed */ }
      };
      // Keep the raw work promise separate from the bounded caller result. If a
      // request times out or is cancelled, the caller returns promptly but the
      // per-tab lock is held until Chromium has actually settled the stopped work.
      const work = operation();
      const result = this.withTimeout(work, request.timeoutMs, signal, stop).catch((error: unknown) => {
        const managerError = error instanceof BrowserManagerError ? error : new BrowserManagerError('INTERNAL', error instanceof Error ? error.message : String(error));
        const current = this.resolveTab(request.tabId, false) ?? this.resolveTab(undefined, false);
        return this.failure(request.id, managerError.code, managerError.message, current);
      });
      const settled = work.then(() => undefined, () => undefined);
      this.rawSettlements.set(request.id, settled);
      void settled.finally(() => {
        if (this.rawSettlements.get(request.id) === settled) this.rawSettlements.delete(request.id);
      });
      return { result, settled };
    };
    const queueTab = request.tabId ?? this.activeTabId;
    // Prompts frequently arrive while a navigation or scripted interaction is
    // still occupying the tab queue. Responses must bypass that queue or auth,
    // certificate, beforeunload, and JavaScript dialogs can deadlock forever.
    if (!queueTab || ['state', 'create-tab', 'close-tab', 'reopen-tab', 'respond-permission', 'respond-dialog', 'stop'].includes(request.command.op)) {
      return startBoundedOperation().result;
    }
    return this.enqueue(queueTab, startBoundedOperation);
  }

  setWorkspaceRoot(workspaceRoot: string): void {
    if (!workspaceRoot || workspaceRoot === this.workspaceRoot) return;
    const previousSession = session.fromPartition(this.partition);
    if (this.downloadListener) {
      previousSession.off('will-download', this.downloadListener);
      this.downloadListener = null;
    }
    this.workspaceGeneration += 1;
    this.visibleAgentPin = null;
    this.persistWorkspace();
    this.destroyAllViews();
    this.workspaceRoot = workspaceRoot;
    this.partition = browserPartitionForWorkspace(workspaceRoot);
    this.sessionKey = null;
    this.tabs = [];
    this.activeTabId = '';
    this.closedTabs = [];
    this.trustedUserPrivateOrigins.clear();
    this.userOriginChecks.clear();
    this.humanChallengeTabs.clear();
    configureBrowserSession(session.fromPartition(this.partition));
    this.installDownloadListener();
    this.restoreWorkspace();
    if (this.tabs.length === 0) this.createTab(BROWSER_BLANK_URL, true);
    this.attachActiveView();
    this.emitState();
  }

  /** Record the active chat without rotating the workspace browser profile.
   * Browser tabs, sign-ins, cookies, and completed challenges intentionally
   * remain continuous across chats in the same workspace. */
  setSession(sessionKey: string | null): void {
    this.sessionKey = sessionKey;
  }

  /** Compatibility operation for chat deletion. Browser state is workspace
   * scoped, so deleting one chat must not sign every other chat out. Users can
   * explicitly clear or reset the workspace browser from the Browser panel. */
  async clearSessionData(sessionKey: string): Promise<void> {
    if (this.sessionKey === sessionKey) this.sessionKey = null;
  }

  hasPermission(rawOrigin: string, grants: string[]): boolean {
    if (grants.length === 0) return false;
    let origin = rawOrigin;
    try { origin = new URL(rawOrigin).origin; } catch { /* invalid origins have no grants */ }
    return grants.every((permission) => this.permissionGrants.has(`${origin}\n${permission}`));
  }

  requestPermission(contentsId: number, permission: string, grants: string[], rawOrigin: string, callback: (allow: boolean) => void): void {
    const tab = this.tabForContents(contentsId);
    if (!tab || grants.length === 0) { callback(false); return; }
    let origin = '';
    try { origin = new URL(rawOrigin || tab.url).origin; } catch { origin = rawOrigin || tab.url; }
    const decisionKey = `${origin}\n${permission}`;
    const savedDecision = permission === 'geolocation' ? this.permissionDecisions.get(decisionKey) : undefined;
    if (savedDecision) { callback(savedDecision === 'allow'); return; }
    if (this.hasPermission(origin, grants)) { callback(true); return; }
    if (this.pendingPermission) {
      clearTimeout(this.pendingPermission.timer);
      this.pendingPermission.cancel();
    }
    const id = `permission_${++this.permissionSequence}`;
    const finish = (allow: boolean, remember: boolean): void => {
      if (allow) for (const grant of grants) this.permissionGrants.add(`${origin}\n${grant}`);
      if (remember && permission === 'geolocation') {
        this.permissionDecisions.set(decisionKey, allow ? 'allow' : 'block');
        this.persistWorkspace();
      }
      callback(allow);
      if (this.pendingPermission?.id === id) this.pendingPermission = null;
      this.permissionPrompt = null;
      this.emit({ type: 'permission', prompt: null });
      this.emitState();
    };
    const timer = setTimeout(() => finish(false, false), PERMISSION_TIMEOUT_MS);
    this.pendingPermission = {
      id,
      tabId: tab.id,
      respond: (allow) => finish(allow, true),
      cancel: () => finish(false, false),
      timer,
    };
    this.permissionPrompt = { id, tabId: tab.id, origin: boundBrowserText(origin, 512), permission: boundBrowserText(permission, 128) };
    this.selectTab(tab.id);
    this.emit({ type: 'permission', prompt: this.permissionPrompt });
    this.emitState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.persistWorkspace();
    this.disposed = true;
    if (this.pendingPermission) {
      clearTimeout(this.pendingPermission.timer);
      this.pendingPermission.cancel();
      this.pendingPermission = null;
    }
    this.cancelPendingDialog();
    if (this.downloadListener) {
      session.fromPartition(this.partition).off('will-download', this.downloadListener);
      this.downloadListener = null;
    }
    this.destroyAllViews();
    this.downloadItems.clear();
    this.downloadWorkspaces.clear();
    this.agentNavigationPolicies.clear();
    this.agentControlledTabs.clear();
    this.trustedUserPrivateOrigins.clear();
    this.userOriginChecks.clear();
    this.agentDownloadAllowances.clear();
    this.syntheticInputUntil.clear();
    for (const tabId of [...this.stagedUploads.keys()]) this.cleanupStagedUpload(tabId);
    for (const controller of this.pendingAuthPrompts.values()) controller.abort();
    this.pendingAuthPrompts.clear();
    this.rawSettlements.clear();
  }

  /** Bound the agent's background-tab churn: close the OLDEST agent-controlled
   *  tabs so that after the next agent tab opens there are at most MAX_AGENT_TABS
   *  of them. Never touches user-opened tabs or the tab the user is viewing. */
  private reapAgentTabs(): void {
    const MAX_AGENT_TABS = 4;
    const reapable = this.tabs.filter((tab) => this.agentControlledTabs.has(tab.id) && tab.id !== this.activeTabId);
    const excess = reapable.length - (MAX_AGENT_TABS - 1);
    for (let i = 0; i < excess; i += 1) {
      try { this.closeTab(reapable[i].id); } catch { /* best effort */ }
    }
  }

  private createTab(rawUrl = BROWSER_BLANK_URL, active = true, options?: {
    deferLoad?: boolean;
    title?: string;
    agentPolicy?: AgentNavigationPolicy;
    agentControlled?: boolean;
  }): BrowserTab {
    // Agents open a tab per fetch/search/navigate and rarely close them, which
    // floods the strip and hits MAX_BROWSER_TABS. Before opening a NEW agent tab,
    // close the oldest agent-controlled tabs beyond a small cap. User-opened tabs
    // and the tab the user is currently viewing are never reaped.
    if (options?.agentControlled) this.reapAgentTabs();
    if (this.tabs.length >= MAX_BROWSER_TABS) throw new BrowserManagerError('TAB_LIMIT', `A maximum of ${MAX_BROWSER_TABS} tabs is supported.`);
    const url = this.safeUrl(rawUrl);
    const id = `tab_${this.windowPrefix}_${++this.tabSequence}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        safeDialogsMessage: 'Additional dialogs from this page were blocked.',
        // Never timer-throttle the browser view. A WebContentsView's occlusion
        // can be mis-detected under the renderer overlay, and throttling the
        // active tab to ~1 tick/sec makes JS-heavy sites (login flows, SPAs)
        // crawl or stall mid-load — the "takes forever to load" symptom.
        backgroundThrottling: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab = initialTab(id, url, options?.title);
    this.tabs.push(tab);
    this.records.set(id, { view, console: [] });
    if (options?.agentControlled) {
      this.agentNavigationPolicies.set(id, options.agentPolicy ?? {});
      this.agentControlledTabs.add(id);
    }
    managersByWebContents.set(view.webContents.id, this);
    this.wireView(tab, view.webContents);
    if (active || !this.activeTabId) this.selectTab(id);
    if (!options?.deferLoad) void view.webContents.loadURL(url).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // ERR_ABORTED means the navigation was superseded/cancelled (a redirect, or
      // a new navigation started) — that is normal, not a failure. Surfacing it as
      // "Load failed" is the scary red line users see on sites like Google.
      if (/ERR_ABORTED/i.test(message)) return;
      this.setStatus(tab, `Load failed: ${message}`);
    });
    if (!options?.agentControlled) void this.recordUserPrivateOrigin(url);
    this.persistWorkspace();
    this.emitState();
    return tab;
  }

  private wireView(tab: BrowserTab, contents: WebContents): void {
    const updateNavigation = (): void => {
      if (contents.isDestroyed()) return;
      const url = contents.getURL();
      if (url) tab.url = boundBrowserText(url, 8_192);
      tab.canGoBack = contents.navigationHistory.canGoBack();
      tab.canGoForward = contents.navigationHistory.canGoForward();
      tab.zoomFactor = contents.getZoomFactor();
      tab.crashed = false;
      this.updateHumanChallenge(tab);
      if (!this.agentControlledTabs.has(tab.id)) void this.recordUserPrivateOrigin(tab.url);
      tab.revision += 1;
      this.persistWorkspace();
      this.emitState();
    };
    const gate = (event: { preventDefault(): void }, url: string): void => {
      if (!this.isSafeUrl(url)) {
        event.preventDefault();
        this.setStatus(tab, `Blocked unsafe navigation to ${boundBrowserText(url, 256)}`);
      }
    };
    contents.on('will-navigate', gate);
    contents.on('will-redirect', gate);
    contents.on('did-navigate', updateNavigation);
    contents.on('did-navigate-in-page', updateNavigation);
    contents.on('did-start-loading', () => { tab.loading = true; this.emitState(); });
    contents.on('did-stop-loading', () => { tab.loading = false; updateNavigation(); });
    contents.on('page-title-updated', (_event, title) => {
      tab.title = boundBrowserText(title || 'New tab', 256);
      this.updateHumanChallenge(tab);
      this.persistWorkspace();
      this.emitState();
    });
    contents.on('page-favicon-updated', (_event, favicons) => { tab.faviconUrl = favicons.find((value) => /^https?:|^data:image\//i.test(value)) ?? null; this.emitState(); });
    contents.on('media-started-playing', () => { tab.audible = true; this.emitState(); });
    contents.on('media-paused', () => { tab.audible = false; this.emitState(); });
    contents.on('render-process-gone', (_event, details) => { tab.crashed = true; tab.loading = false; this.setStatus(tab, `Tab crashed (${details.reason}). Reload to recover.`); this.emitState(); });
    contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.loading = false;
      this.setStatus(tab, `Load failed: ${description} (${boundBrowserText(validatedUrl, 512)})`);
      this.emitState();
    });
    contents.on('console-message', (_event, level, message, line, sourceId) => {
      const record = this.records.get(tab.id);
      if (!record) return;
      record.console.push({ level: String(level), text: boundBrowserText(message, 4_096), source: boundBrowserText(sourceId, 512), line, at: Date.now() });
      if (record.console.length > MAX_CONSOLE_ROWS) record.console.splice(0, record.console.length - MAX_CONSOLE_ROWS);
    });
    contents.on('before-input-event', (event, input) => {
      if (!this.isSyntheticAgentInput(tab.id)) {
        if (this.visibleAgentPin?.tabId === tab.id) {
          event.preventDefault();
          this.visibleAgentPin.userTakeoverRequested = true;
          this.agentTakeoverHandler?.();
          return;
        }
        this.releaseAgentControl(tab.id);
      }
      this.handleShortcut(event, input);
    });
    contents.on('before-mouse-event', (event) => {
      if (!this.isSyntheticAgentInput(tab.id)) {
        if (this.visibleAgentPin?.tabId === tab.id) {
          event.preventDefault();
          this.visibleAgentPin.userTakeoverRequested = true;
          this.agentTakeoverHandler?.();
          return;
        }
        this.releaseAgentControl(tab.id);
      }
    });
    contents.on('context-menu', (_event, params) => this.showContextMenu(tab, params));
    contents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
      event.preventDefault();
      if (authInfo.isProxy) {
        // Proxy credentials are deliberately unsupported: presenting the
        // destination origin for a 407 challenge can trick a user into sending
        // site credentials to an intermediary. Fail closed without a secret UI.
        this.setStatus(tab, `Proxy authentication was blocked for ${boundBrowserText(`${authInfo.host}:${authInfo.port}`, 512)}.`);
        callback();
        return;
      }
      let origin = authenticationResponseDetails.url;
      try { origin = new URL(authenticationResponseDetails.url).origin; } catch { /* retain bounded URL */ }
      const realm = boundBrowserText(authInfo.realm || authInfo.scheme || 'this site', 256);
      this.pendingAuthPrompts.get(tab.id)?.abort();
      const controller = new AbortController();
      this.pendingAuthPrompts.set(tab.id, controller);
      this.selectTab(tab.id);
      void promptForHttpAuth(this.win, {
        origin: boundBrowserText(origin || `${authInfo.host}:${authInfo.port}`, 512),
        realm,
      }, { signal: controller.signal, timeoutMs: DIALOG_TIMEOUT_MS }).then((credentials) => {
        if (!credentials) callback();
        else callback(boundBrowserText(credentials.username, 1_024), boundBrowserText(credentials.password, 8_192));
      }, () => callback()).finally(() => {
        if (this.pendingAuthPrompts.get(tab.id) === controller) this.pendingAuthPrompts.delete(tab.id);
      });
    });
    contents.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault();
      if (!isMainFrame) { callback(false); return; }
      let origin = url;
      try { origin = new URL(url).origin; } catch { /* retain bounded URL */ }
      const subject = certificate.subjectName || certificate.subject?.commonName || 'unknown certificate';
      this.presentDialog(tab, {
        kind: 'certificate',
        message: `${boundBrowserText(error, 256)} (${boundBrowserText(subject, 256)}). Continue only if you trust this site.`,
        origin: boundBrowserText(origin, 512),
      }, (response) => callback(response.accept));
    });
    contents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || !params || typeof params !== 'object') return;
      const details = params as { type?: unknown; message?: unknown; defaultPrompt?: unknown; url?: unknown };
      const kind = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(details.type))
        ? String(details.type) as 'alert' | 'confirm' | 'prompt' | 'beforeunload'
        : 'alert';
      this.presentDialog(tab, {
        kind,
        message: boundBrowserText(details.message, 4_096),
        defaultValue: kind === 'prompt' ? boundBrowserText(details.defaultPrompt, 4_096) : undefined,
        origin: typeof details.url === 'string' ? boundBrowserText(details.url, 512) : undefined,
      }, (response) => {
        if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
        void contents.debugger.sendCommand('Page.handleJavaScriptDialog', {
          accept: response.accept,
          ...(kind === 'prompt' ? { promptText: boundBrowserText(response.value, 4_096) } : {}),
        }).catch((error) => this.setStatus(tab, `Could not answer page dialog: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
    try {
      this.ensureDebugger(contents);
    } catch (error) {
      // Browsing remains usable with Chromium's native dialogs if CDP is
      // unavailable. Agent dialog control will fail closed instead of injecting
      // a guest preload or weakening the page sandbox.
      this.setStatus(tab, `Dialog automation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    contents.setWindowOpenHandler((details) => {
      if (!this.isSafeUrl(details.url) && details.url !== 'about:blank') return { action: 'deny' };
      try {
        const inheritedPolicy = this.agentNavigationPolicies.get(tab.id);
        const agentControlled = this.agentControlledTabs.has(tab.id);
        const child = this.createTab(details.url === 'about:blank' ? BROWSER_BLANK_URL : details.url, true, {
          deferLoad: true,
          agentControlled,
          agentPolicy: inheritedPolicy ?? {},
        });
        if (agentControlled) {
          // A target=_blank navigation remains part of the same agent action.
          // Transfer (rather than duplicate) the one-shot download gesture so
          // the opener and popup cannot each consume it.
          const allowance = this.agentDownloadAllowances.get(tab.id);
          if (allowance && allowance >= Date.now()) {
            this.agentDownloadAllowances.delete(tab.id);
            this.agentDownloadAllowances.set(child.id, allowance);
          }
        }
        const record = this.records.get(child.id);
        if (!record) return { action: 'deny' };
        return { action: 'allow', createWindow: () => record.view.webContents };
      } catch {
        return { action: 'deny' };
      }
    });
  }

  private async resolveAgentNavigationPolicy(rawUrl: string): Promise<AgentNavigationPolicy> {
    const url = this.safeUrl(rawUrl);
    let origin = '';
    try { origin = new URL(url).origin; } catch { throw new BrowserManagerError('UNSAFE_URL', 'The agent browser URL is invalid.'); }
    let policy: AgentNavigationPolicy = {};
    if (!await this.destinationAllowed(url, policy)) {
      policy = { allowedPrivateOrigin: this.trustedUserPrivateOrigins.has(origin) ? origin : undefined };
    }
    if (!await this.destinationAllowed(url, policy)) {
      throw new BrowserManagerError('UNSAFE_URL', 'Agent navigation to private, local, metadata, or unresolved network targets is blocked. Open a local development origin manually before granting the agent control of it.');
    }
    return policy;
  }

  private async agentPolicyForExistingTab(tab: BrowserTab): Promise<AgentNavigationPolicy> {
    try {
      const url = new URL(tab.url);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && tab.url !== BROWSER_BLANK_URL) {
        await this.userOriginChecks.get(url.origin);
        return this.trustedUserPrivateOrigins.has(url.origin) ? { allowedPrivateOrigin: url.origin } : {};
      }
    } catch { /* blank/internal tabs retain a strict policy */ }
    return {};
  }

  private recordUserPrivateOrigin(rawUrl: string): Promise<void> {
    let origin = '';
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve();
      origin = url.origin;
    } catch { return Promise.resolve(); }
    const existing = this.userOriginChecks.get(origin);
    if (existing) return existing;
    const check = (async () => {
      // A private origin is trusted only when Chromium reached it while the tab
      // was under explicit user control. Merely sharing an origin string with
      // an agent-opened tab is insufficient and cannot bless DNS rebinding.
      if (await this.destinationAllowed(rawUrl, {})) return;
      if (await this.destinationAllowed(rawUrl)) this.trustedUserPrivateOrigins.add(origin);
    })().finally(() => {
      if (this.userOriginChecks.get(origin) === check) this.userOriginChecks.delete(origin);
    });
    this.userOriginChecks.set(origin, check);
    return check;
  }

  private assertOperationCurrent(generation: number, signal?: AbortSignal, tabId?: BrowserTabId): void {
    if (signal?.aborted || this.disposed || generation !== this.workspaceGeneration) {
      throw new BrowserManagerError('CANCELLED', 'Browser command was cancelled before its next side effect.');
    }
    if (tabId && !this.resolveTab(tabId, false)) {
      throw new BrowserManagerError('TAB_NOT_FOUND', 'Browser tab is no longer available.');
    }
  }

  private async runCommand(
    command: BrowserCommand,
    tab: BrowserTab | null,
    operation: { signal?: AbortSignal; generation: number; agentNewTabPolicy?: AgentNavigationPolicy },
  ): Promise<unknown> {
    const assertCurrent: BrowserOperationGuard = () => this.assertOperationCurrent(operation.generation, operation.signal, tab?.id);
    assertCurrent();
    switch (command.op) {
      case 'state': return this.getState();
      case 'create-tab': return this.createTab(command.url ?? BROWSER_BLANK_URL, command.active !== false, {
        agentControlled: Boolean(operation.signal),
        agentPolicy: operation.agentNewTabPolicy,
      });
      case 'select-tab': return this.selectTab(command.tabId);
      case 'close-tab': return this.closeTab(command.tabId ?? tab?.id ?? this.activeTabId);
      case 'reopen-tab': return this.reopenTab();
      case 'reorder-tab': return this.reorderTab(command.tabId, command.toIndex);
      case 'navigate': {
        const current = this.requireTab(tab); const contents = this.requireContents(current.id); const url = this.safeUrl(command.url);
        current.crashed = false; await contents.loadURL(url); assertCurrent(); return { url };
      }
      case 'back': { const c = this.requireContents(this.requireTab(tab).id); if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); return { ok: true }; }
      case 'forward': { const c = this.requireContents(this.requireTab(tab).id); if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); return { ok: true }; }
      case 'reload': { const c = this.requireContents(this.requireTab(tab).id); command.bypassCache ? c.reloadIgnoringCache() : c.reload(); return { ok: true }; }
      case 'stop': { this.requireContents(this.requireTab(tab).id).stop(); return { ok: true }; }
      case 'find': {
        const text = boundBrowserText(command.text, 512); if (!text) throw new BrowserManagerError('INVALID_REQUEST', 'Find text is empty.');
        return this.findInPage(this.requireTab(tab), text, command.forward, command.findNext);
      }
      case 'stop-find': { this.requireContents(this.requireTab(tab).id).stopFindInPage(command.action ?? 'clearSelection'); return { ok: true }; }
      case 'set-zoom': {
        const factor = Math.min(5, Math.max(0.25, Number(command.factor))); const current = this.requireTab(tab);
        this.requireContents(current.id).setZoomFactor(factor); current.zoomFactor = factor; this.emitState(); return { factor };
      }
      case 'set-muted': {
        const current = this.requireTab(tab); this.requireContents(current.id).setAudioMuted(command.muted); current.muted = command.muted; this.emitState(); return { muted: command.muted };
      }
      case 'snapshot': return this.snapshot(this.requireTab(tab), command.mode);
      case 'text': return this.pageText(this.requireTab(tab), command.maxChars);
      case 'html': return this.pageHtml(this.requireTab(tab), command.maxChars);
      case 'screenshot': return this.screenshot(this.requireTab(tab), command.maxDimension, command.fullPage);
      case 'console': {
        const current = this.requireTab(tab); const rows = [...(this.records.get(current.id)?.console ?? [])];
        if (command.clear) { const record = this.records.get(current.id); if (record) record.console = []; }
        return rows;
      }
      case 'network': {
        const current = this.requireTab(tab); const rows = await this.isolated<BrowserNetworkEntry[]>(current.id, performanceNetworkScript());
        assertCurrent();
        if (command.clear) await this.isolated(current.id, `(() => { try { performance.clearResourceTimings(); } catch {} return true; })()`);
        return boundBrowserArray(rows ?? [], MAX_NETWORK_ROWS);
      }
      case 'downloads': return this.workspaceDownloads();
      case 'click': case 'double-click': case 'hover': case 'assert-visible': case 'highlight':
        return this.pointerCommand(this.requireTab(tab), command, assertCurrent);
      case 'type': return this.typeCommand(this.requireTab(tab), command, assertCurrent);
      case 'press': return this.pressCommand(this.requireTab(tab), command);
      case 'scroll': return this.scrollCommand(this.requireTab(tab), command);
      case 'drag': return this.dragCommand(this.requireTab(tab), command, assertCurrent);
      case 'select': return this.selectCommand(this.requireTab(tab), command, assertCurrent);
      case 'check': return this.checkCommand(this.requireTab(tab), command, assertCurrent);
      case 'set-files': return this.setFilesCommand(this.requireTab(tab), command, assertCurrent);
      case 'set-cursor': return this.setCursor(this.requireTab(tab), command.enabled);
      case 'set-device': return this.setDevice(this.requireTab(tab), command.device, assertCurrent);
      case 'clear-highlight': return this.isolated(this.requireTab(tab).id, `(() => { document.getElementById('__brainrouter_testid_highlights__')?.remove(); const el=window.__brainrouterHighlighted; if(el){el.style.outline=window.__brainrouterPreviousOutline||'';el.style.outlineOffset='';} window.__brainrouterHighlighted=null; return {ok:true}; })()`);
      case 'respond-permission': return this.respondPermission(command.promptId, command.allow);
      case 'respond-dialog': return this.respondDialog(command);
      case 'open-download': case 'show-download': case 'cancel-download': case 'pause-download': case 'resume-download': return this.downloadCommand(command.op, command.downloadId);
      case 'clear-data': return this.clearData(command.dataTypes);
      case 'reset-browser': return this.resetBrowser();
      case 'clear-session-data': {
        if (typeof command.sessionKey !== 'string' || !command.sessionKey) throw new BrowserManagerError('INVALID_REQUEST', 'clear-session-data requires a sessionKey.');
        await this.clearSessionData(command.sessionKey);
        return { ok: true };
      }
      default: throw new BrowserManagerError('INVALID_REQUEST', 'Unknown browser command.');
    }
  }

  private selectTab(id: string): BrowserTab {
    const tab = this.resolveTab(id);
    if (!tab) throw new BrowserManagerError('TAB_NOT_FOUND', `Browser tab ${id} was not found.`);
    if (this.visibleAgentPin && this.visibleAgentPin.tabId !== id) {
      this.visibleAgentPin.deferredSelection = id;
      return { ...this.requireTab(this.resolveTab(this.visibleAgentPin.tabId)) };
    }
    this.activeTabId = id;
    tab.lastAccessedAt = Date.now();
    this.attachActiveView();
    this.persistWorkspace();
    this.emitState();
    return { ...tab };
  }

  private closeTab(id: string): BrowserTab {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) throw new BrowserManagerError('TAB_NOT_FOUND', `Browser tab ${id} was not found.`);
    const [tab] = this.tabs.splice(index, 1);
    if (tab.url !== BROWSER_BLANK_URL) this.closedTabs.push({ url: persistableBrowserUrl(tab.url), title: tab.title });
    this.closedTabs = this.closedTabs.slice(-25);
    this.destroyView(id);
    if (this.tabs.length === 0) {
      this.activeTabId = '';
      this.createTab(BROWSER_BLANK_URL, true);
    } else if (this.activeTabId === id) {
      this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      this.attachActiveView();
    }
    this.persistWorkspace();
    this.emitState();
    return { ...tab };
  }

  private reopenTab(): BrowserTab {
    const closed = this.closedTabs.pop();
    return this.createTab(closed?.url ?? BROWSER_BLANK_URL, true, { title: closed?.title });
  }

  private reorderTab(id: string, toIndex: number): BrowserTab[] {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) throw new BrowserManagerError('TAB_NOT_FOUND', `Browser tab ${id} was not found.`);
    const target = Math.max(0, Math.min(this.tabs.length - 1, Math.floor(toIndex)));
    const [tab] = this.tabs.splice(from, 1); this.tabs.splice(target, 0, tab);
    this.persistWorkspace(); this.emitState(); return this.tabs.map((entry) => ({ ...entry }));
  }

  private async snapshot(tab: BrowserTab, mode: 'semantic' | 'testids' | 'accessibility' = 'semantic'): Promise<unknown> {
    tab.revision += 1;
    const snapshot = await this.isolated<{ url: string; title: string; nodes: BrowserSemanticNode[] }>(tab.id, semanticSnapshotScript(tab.id, tab.revision));
    this.emitState();
    if (mode === 'testids') return { ...snapshot, nodes: snapshot.nodes.filter((node) => node.testid) };
    if (mode === 'accessibility') return { ...snapshot, nodes: snapshot.nodes.filter((node) => node.role) };
    return snapshot;
  }

  /** Clean, readable page text (rendered innerText) — the primitive `fetch_url`
   *  uses when routing research through the in-app browser, so it gets article
   *  text rather than the structural semantic snapshot. Bounded in-page. */
  private async pageText(tab: BrowserTab, maxChars?: number): Promise<{ url: string; title: string; text: string }> {
    const cap = Math.max(1_000, Math.min(200_000, Math.floor(maxChars ?? 100_000)));
    return this.isolated<{ url: string; title: string; text: string }>(
      tab.id,
      `(() => { const raw = (document.body && document.body.innerText) || (document.documentElement && document.documentElement.innerText) || ''; return { url: location.href, title: document.title || '', text: String(raw).replace(/\\n{3,}/g, '\\n\\n').slice(0, ${cap}) }; })()`,
    );
  }

  /** The tab's RENDERED HTML (post-JS document.documentElement.outerHTML),
   *  bounded. Used to run structured extraction (e.g. web_search parsing a
   *  search-results page) over what the real browser actually rendered, so the
   *  network + JS execution + session all go through the in-app browser rather
   *  than a raw HTTP scrape. */
  private async pageHtml(tab: BrowserTab, maxChars?: number): Promise<{ url: string; title: string; html: string }> {
    const cap = Math.max(1_000, Math.min(500_000, Math.floor(maxChars ?? 300_000)));
    return this.isolated<{ url: string; title: string; html: string }>(
      tab.id,
      `(() => { const raw = (document.documentElement && document.documentElement.outerHTML) || ''; return { url: location.href, title: document.title || '', html: String(raw).slice(0, ${cap}) }; })()`,
    );
  }

  private async screenshot(tab: BrowserTab, requestedMax?: number, fullPage = false): Promise<{ dataUrl: string; width: number; height: number; fullPage: boolean }> {
    if (fullPage) {
      const contents = this.requireContents(tab.id);
      try {
        this.ensureDebugger(contents);
        const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as { cssContentSize?: { width?: number; height?: number }; contentSize?: { width?: number; height?: number } };
        const size = metrics.cssContentSize ?? metrics.contentSize ?? {};
        const capture = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }) as { data?: string };
        const dataUrl = `data:image/png;base64,${capture.data ?? ''}`;
        if (!capture.data || Buffer.byteLength(dataUrl, 'utf8') > MAX_BROWSER_IMAGE_BYTES) throw new BrowserManagerError('TOO_LARGE', 'Full-page screenshot exceeded the 8 MB browser observation limit.');
        return { dataUrl, width: Math.round(size.width ?? this.surface.width), height: Math.round(size.height ?? this.surface.height), fullPage: true };
      } catch (error) {
        if (error instanceof BrowserManagerError) throw error;
        // Some protected/internal pages refuse the DevTools capture path; fall
        // back to a normal viewport capture and label it accurately.
      }
    }
    let image = await this.requireContents(tab.id).capturePage();
    const current = image.getSize();
    const maxDimension = Math.min(3_840, Math.max(320, Math.floor(requestedMax ?? 2_048)));
    if (Math.max(current.width, current.height) > maxDimension) {
      const ratio = maxDimension / Math.max(current.width, current.height);
      image = image.resize({ width: Math.max(1, Math.round(current.width * ratio)), height: Math.max(1, Math.round(current.height * ratio)), quality: 'good' });
    }
    const dataUrl = image.toDataURL();
    if (Buffer.byteLength(dataUrl, 'utf8') > MAX_BROWSER_IMAGE_BYTES) throw new BrowserManagerError('TOO_LARGE', 'Screenshot exceeded the 8 MB browser observation limit.');
    return { dataUrl, ...image.getSize(), fullPage: false };
  }

  private async pointerCommand(
    tab: BrowserTab,
    command: Extract<BrowserCommand, { op: 'click' | 'double-click' | 'hover' | 'assert-visible' | 'highlight' }>,
    assertCurrent: BrowserOperationGuard,
  ): Promise<unknown> {
    this.validateRef(tab, command.ref);
    if (command.op === 'highlight' && !command.ref && !command.target && !command.label) {
      assertCurrent();
      return this.isolated(tab.id, `(() => { const id='__brainrouter_testid_highlights__';document.getElementById(id)?.remove();const style=document.createElement('style');style.id=id;style.textContent='[data-testid]{outline:2px solid #7c5cff !important;outline-offset:1px !important}';document.documentElement.appendChild(style);return {ok:true,count:document.querySelectorAll('[data-testid]').length};})()`);
    }
    const target = await this.isolated<{ ok: boolean; visible?: boolean; error?: string; rect?: { x: number; y: number; width: number; height: number } }>(tab.id, targetScript(tab.id, tab.revision, command.ref, command.target, command.label, command.targetType));
    assertCurrent();
    if (!target.ok || !target.rect) throw new BrowserManagerError('REF_NOT_FOUND', target.error || 'Element was not found.');
    if (!target.visible) throw new BrowserManagerError('REF_NOT_FOUND', 'Element is not visible.');
    if (command.op === 'assert-visible') return { ok: true };
    if (command.op === 'highlight') {
      assertCurrent();
      return this.isolated(tab.id, `(() => { const s=window.__brainrouterAgentRefs; const el=s&&s.nodes.get(${JSON.stringify(command.ref ?? '')}); if(!el)return {ok:false}; const prev=window.__brainrouterHighlighted;if(prev){prev.style.outline=window.__brainrouterPreviousOutline||'';} window.__brainrouterHighlighted=el;window.__brainrouterPreviousOutline=el.style.outline;el.style.outline='2px solid #7c5cff';el.style.outlineOffset='2px';el.scrollIntoView({block:'center'});return {ok:true}; })()`);
    }
    const x = Math.round(target.rect.x + target.rect.width / 2), y = Math.round(target.rect.y + target.rect.height / 2);
    // Glide the visible cursor to the target (ripple on a click) before the real input.
    this.showAgentPointer(tab.id, x, y, command.op !== 'hover');
    this.sendAgentInput(tab.id, { type: 'mouseMove', x, y });
    if (command.op === 'hover') return { ok: true, x, y };
    const count = command.op === 'double-click' ? 2 : 1;
    const button = command.button ?? 'left';
    const modifiers = (command.modifiers ?? []).map((value) => value.toLowerCase() as 'alt' | 'control' | 'meta' | 'shift');
    this.sendAgentInput(tab.id, { type: 'mouseDown', x, y, button, clickCount: count, modifiers });
    this.sendAgentInput(tab.id, { type: 'mouseUp', x, y, button, clickCount: count, modifiers });
    tab.revision += 1; this.emitState(); return { ok: true, x, y };
  }

  private async typeCommand(
    tab: BrowserTab,
    command: Extract<BrowserCommand, { op: 'type' }>,
    assertCurrent: BrowserOperationGuard,
  ): Promise<unknown> {
    this.validateRef(tab, command.ref);
    const text = boundBrowserText(command.text, 20_000);
    const focus = await this.isolated<{ ok: boolean; error?: string }>(tab.id, `(() => { const s=window.__brainrouterAgentRefs; let el=${command.ref ? `s&&s.revision===${tab.revision}&&s.nodes.get(${JSON.stringify(command.ref)})` : 'null'}; if(!el&&${JSON.stringify(command.target ?? '')}){const t=${JSON.stringify(command.target ?? '')};el=document.querySelector('[data-testid="'+(CSS.escape?CSS.escape(t):t)+'"]')||document.getElementById(t);} if(!el)return {ok:false,error:'Element was not found.'};el.scrollIntoView({block:'center'});el.focus();${command.replace !== false ? `if('value' in el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}` : ''}return {ok:true}; })()`);
    assertCurrent();
    if (!focus.ok) throw new BrowserManagerError('REF_NOT_FOUND', focus.error || 'Element was not found.');
    this.syntheticInputUntil.set(tab.id, Date.now() + 100);
    this.requireContents(tab.id).insertText(text);
    tab.revision += 1; this.emitState(); return { ok: true, characters: text.length };
  }

  private pressCommand(tab: BrowserTab, command: Extract<BrowserCommand, { op: 'press' }>): { ok: true } {
    const keyCode = boundBrowserText(command.key, 64); if (!keyCode) throw new BrowserManagerError('INVALID_REQUEST', 'Key is required.');
    const modifiers: Array<'alt' | 'control' | 'meta' | 'shift'> = (command.modifiers ?? []).map((value) => value.toLowerCase() as 'alt' | 'control' | 'meta' | 'shift');
    this.sendAgentInput(tab.id, { type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && !modifiers.some((value) => value === 'control' || value === 'meta')) this.sendAgentInput(tab.id, { type: 'char', keyCode, modifiers });
    this.sendAgentInput(tab.id, { type: 'keyUp', keyCode, modifiers });
    tab.revision += 1; this.emitState(); return { ok: true };
  }

  private scrollCommand(tab: BrowserTab, command: Extract<BrowserCommand, { op: 'scroll' }>): { ok: true } {
    const x = Math.round(command.x ?? this.surface.width / 2), y = Math.round(command.y ?? this.surface.height / 2);
    this.showAgentPointer(tab.id, x, y, false);
    this.sendAgentInput(tab.id, { type: 'mouseWheel', x, y, deltaX: Math.round(command.deltaX ?? 0), deltaY: Math.round(command.deltaY) });
    return { ok: true };
  }

  private async dragCommand(
    tab: BrowserTab,
    command: Extract<BrowserCommand, { op: 'drag' }>,
    assertCurrent: BrowserOperationGuard,
  ): Promise<{ ok: true }> {
    this.validateRef(tab, command.fromRef); this.validateRef(tab, command.toRef);
    const from = await this.isolated<{ ok: boolean; rect?: { x: number; y: number; width: number; height: number } }>(tab.id, targetScript(tab.id, tab.revision, command.fromRef));
    const to = await this.isolated<{ ok: boolean; rect?: { x: number; y: number; width: number; height: number } }>(tab.id, targetScript(tab.id, tab.revision, command.toRef));
    assertCurrent();
    if (!from.ok || !from.rect || !to.ok || !to.rect) throw new BrowserManagerError('REF_NOT_FOUND', 'Drag source or destination was not found.');
    const sx = Math.round(from.rect.x + from.rect.width / 2), sy = Math.round(from.rect.y + from.rect.height / 2);
    const tx = Math.round(to.rect.x + to.rect.width / 2), ty = Math.round(to.rect.y + to.rect.height / 2);
    this.showAgentPointer(tab.id, sx, sy, true);
    this.sendAgentInput(tab.id, { type: 'mouseMove', x: sx, y: sy }); this.sendAgentInput(tab.id, { type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 });
    this.showAgentPointer(tab.id, tx, ty, false);
    this.sendAgentInput(tab.id, { type: 'mouseMove', x: tx, y: ty, movementX: tx - sx, movementY: ty - sy }); this.sendAgentInput(tab.id, { type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });
    tab.revision += 1; this.emitState(); return { ok: true };
  }

  private async selectCommand(
    tab: BrowserTab,
    command: Extract<BrowserCommand, { op: 'select' }>,
    assertCurrent: BrowserOperationGuard,
  ): Promise<unknown> {
    this.validateRef(tab, command.ref);
    const values = boundBrowserArray(command.values.map((value) => boundBrowserText(value, 512)), 100);
    assertCurrent();
    const result = await this.isolated(tab.id, `(() => { const s=window.__brainrouterAgentRefs;let el=${command.ref ? `s&&s.revision===${tab.revision}&&s.nodes.get(${JSON.stringify(command.ref)})` : 'null'};if(!el&&${JSON.stringify(command.target ?? '')})el=document.querySelector('[data-testid="'+CSS.escape(${JSON.stringify(command.target ?? '')})+'"]');if(!(el instanceof HTMLSelectElement))return {ok:false,error:'Select element was not found.'};const wanted=new Set(${JSON.stringify(values)});for(const o of el.options)o.selected=wanted.has(o.value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,values:Array.from(el.selectedOptions).map(o=>o.value)};})()`);
    assertCurrent();
    tab.revision += 1; this.emitState(); return result;
  }

  private async checkCommand(
    tab: BrowserTab,
    command: Extract<BrowserCommand, { op: 'check' }>,
    assertCurrent: BrowserOperationGuard,
  ): Promise<unknown> {
    this.validateRef(tab, command.ref);
    assertCurrent();
    const result = await this.isolated<{ ok: boolean; error?: string }>(tab.id, `(() => { const s=window.__brainrouterAgentRefs;let el=${command.ref ? `s&&s.revision===${tab.revision}&&s.nodes.get(${JSON.stringify(command.ref)})` : 'null'};if(!el&&${JSON.stringify(command.target ?? '')})el=document.querySelector('[data-testid="'+CSS.escape(${JSON.stringify(command.target ?? '')})+'"]');if(!(el instanceof HTMLInputElement)||!['checkbox','radio'].includes(el.type))return {ok:false,error:'Checkbox or radio was not found.'};if(el.checked!==${command.checked})el.click();return {ok:true,checked:el.checked};})()`);
    assertCurrent();
    if (!result.ok) throw new BrowserManagerError('REF_NOT_FOUND', result.error || 'Checkbox or radio was not found.');
    tab.revision += 1; this.emitState(); return result;
  }

  private async setFilesCommand(
    tab: BrowserTab,
    command: Extract<BrowserCommand, { op: 'set-files' }>,
    assertCurrent: BrowserOperationGuard,
  ): Promise<{ accepted: true; fileCount: number }> {
    this.validateRef(tab, command.ref);
    if (!command.ref && !command.target) throw new BrowserManagerError('INVALID_REQUEST', 'A file input reference or test id is required.');
    const staged = this.stageUploadFiles(command.files);
    const files = staged.files;
    const token = `upload_${randomUUID().replace(/-/g, '')}`;
    assertCurrent();
    const marker = await this.isolated<{ ok: boolean; error?: string }>(tab.id, `(() => {
      const store=window.__brainrouterAgentRefs;
      let el=${command.ref ? `store&&store.revision===${tab.revision}&&store.nodes.get(${JSON.stringify(command.ref)})` : 'null'};
      if(!el&&${JSON.stringify(command.target ?? '')}){const wanted=${JSON.stringify(command.target ?? '')};el=document.querySelector('[data-testid="'+(CSS.escape?CSS.escape(wanted):wanted)+'"]')||document.getElementById(wanted);}
      if(!(el instanceof HTMLInputElement)||el.type!=='file')return {ok:false,error:'File input was not found.'};
      el.setAttribute('data-brainrouter-upload-token',${JSON.stringify(token)});return {ok:true};
    })()`);
    if (!marker.ok) {
      staged.cleanup();
      throw new BrowserManagerError('REF_NOT_FOUND', marker.error || 'File input was not found.');
    }
    assertCurrent();
    const contents = this.requireContents(tab.id);
    this.ensureDebugger(contents);
    try {
      await contents.debugger.sendCommand('DOM.enable');
      assertCurrent();
      const document = await contents.debugger.sendCommand('DOM.getDocument', { depth: 1, pierce: true }) as { root?: { nodeId?: number } };
      assertCurrent();
      const rootNodeId = document.root?.nodeId;
      if (!rootNodeId) throw new BrowserManagerError('REF_NOT_FOUND', 'Page document is unavailable.');
      const match = await contents.debugger.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector: `[data-brainrouter-upload-token="${token}"]`,
      }) as { nodeId?: number };
      assertCurrent();
      if (!match.nodeId) throw new BrowserManagerError('REF_NOT_FOUND', 'File input is no longer attached.');
      await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: match.nodeId, files });
      assertCurrent();
      this.cleanupStagedUpload(tab.id);
      const timer = setTimeout(() => this.cleanupStagedUpload(tab.id), STAGED_UPLOAD_TTL_MS);
      timer.unref?.();
      this.stagedUploads.set(tab.id, { directory: staged.directory, timer });
    } finally {
      await this.isolated(tab.id, `(() => { document.querySelector('[data-brainrouter-upload-token="${token}"]')?.removeAttribute('data-brainrouter-upload-token'); return true; })()`).catch(() => undefined);
      if (!this.stagedUploads.has(tab.id) || this.stagedUploads.get(tab.id)?.directory !== staged.directory) staged.cleanup();
    }
    tab.revision += 1;
    this.emitState();
    return { accepted: true, fileCount: files.length };
  }

  private stageUploadFiles(rawFiles: string[]): { directory: string; files: string[]; cleanup: () => void } {
    if (!Array.isArray(rawFiles) || rawFiles.length < 1 || rawFiles.length > 20) {
      throw new BrowserManagerError('INVALID_REQUEST', 'Upload requires between 1 and 20 workspace files.');
    }
    let realRoot: string;
    try { realRoot = fs.realpathSync(this.workspaceRoot); }
    catch { throw new BrowserManagerError('DENIED', 'The active workspace cannot be resolved for upload.'); }
    let stagingRoot = '';
    const cleanup = (): void => {
      if (!stagingRoot) return;
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      stagingRoot = '';
    };
    try {
      stagingRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'brainrouter-browser-upload-'));
      fs.chmodSync(stagingRoot, 0o700);
      let totalBytes = 0;
      const stagedFiles = rawFiles.map((raw, index) => {
      if (typeof raw !== 'string' || raw.length < 1 || raw.length > 4_096 || /[\u0000-\u001f]/.test(raw)) {
        throw new BrowserManagerError('INVALID_REQUEST', 'Upload file path is invalid.');
      }
      const canonical = raw.replace(/\\/g, '/');
      if (path.posix.isAbsolute(canonical) || path.win32.isAbsolute(raw) || /^[a-z][a-z0-9+.-]*:/i.test(canonical) || canonical.split('/').includes('..')) {
        throw new BrowserManagerError('DENIED', 'Upload files must be workspace-relative and cannot traverse directories.');
      }
      let resolved: string;
      try { resolved = fs.realpathSync(path.resolve(realRoot, canonical)); }
      catch { throw new BrowserManagerError('INVALID_REQUEST', `Upload file does not exist: ${boundBrowserText(canonical, 256)}`); }
      if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
        throw new BrowserManagerError('DENIED', 'Upload file resolves outside the active workspace.');
      }
      let sourceFd = -1;
      let destinationFd = -1;
      try {
        const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
        sourceFd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
        const stats = fs.fstatSync(sourceFd);
        const pathStats = fs.lstatSync(resolved);
        const current = fs.realpathSync(resolved);
        if (!stats.isFile() || pathStats.isSymbolicLink() || stats.dev !== pathStats.dev || stats.ino !== pathStats.ino
          || (current !== realRoot && !current.startsWith(`${realRoot}${path.sep}`))) {
          throw new BrowserManagerError('DENIED', 'Upload file changed during validation.');
        }
        if (stats.size > MAX_STAGED_UPLOAD_FILE_BYTES || totalBytes + stats.size > MAX_STAGED_UPLOAD_TOTAL_BYTES) {
          throw new BrowserManagerError('TOO_LARGE', 'Upload files exceed the 1 GB staging limit.');
        }
        totalBytes += stats.size;
        const itemDirectory = path.join(stagingRoot, String(index));
        fs.mkdirSync(itemDirectory, { mode: 0o700 });
        const filename = path.basename(canonical) || `upload-${index + 1}`;
        const destination = path.join(itemDirectory, filename);
        destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let read = 0;
        while ((read = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
          let offset = 0;
          while (offset < read) offset += fs.writeSync(destinationFd, buffer, offset, read - offset);
        }
        fs.fsyncSync(destinationFd);
        return destination;
      } catch (error) {
        if (error instanceof BrowserManagerError) throw error;
        throw new BrowserManagerError('INVALID_REQUEST', `Upload file cannot be read: ${boundBrowserText(canonical, 256)}`);
      } finally {
        if (sourceFd >= 0) try { fs.closeSync(sourceFd); } catch { /* closed */ }
        if (destinationFd >= 0) try { fs.closeSync(destinationFd); } catch { /* closed */ }
      }
      });
      return { directory: stagingRoot, files: stagedFiles, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private cleanupStagedUpload(tabId: BrowserTabId): void {
    const staged = this.stagedUploads.get(tabId);
    if (!staged) return;
    this.stagedUploads.delete(tabId);
    clearTimeout(staged.timer);
    try { fs.rmSync(staged.directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  private setCursor(tab: BrowserTab, enabled: boolean): Promise<unknown> {
    this.agentCursorEnabled = enabled;
    if (!enabled) {
      return this.isolated(tab.id, removeAgentCursorScript());
    }
    // Park the overlay near the top-left; the first agent action glides it out.
    return this.isolated(tab.id, agentCursorScript(8, 8, false));
  }

  /**
   * Fire-and-forget: glide the agent cursor overlay to (x, y) and, when `click`,
   * pulse a ripple — so the user watches the agent's pointer move and click.
   * No-op when the cursor is toggled off; never blocks the real input event.
   */
  private showAgentPointer(tabId: BrowserTabId, x: number, y: number, click: boolean): void {
    if (!this.agentCursorEnabled) return;
    void this.isolated(tabId, agentCursorScript(x, y, click)).catch(() => undefined);
  }

  private async setDevice(
    tab: BrowserTab,
    device: { name: string; width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean },
    assertCurrent: BrowserOperationGuard,
  ): Promise<unknown> {
    const width = Math.min(7_680, Math.max(240, Math.floor(device.width)));
    const height = Math.min(7_680, Math.max(240, Math.floor(device.height)));
    const deviceScaleFactor = Math.min(4, Math.max(0.5, Number(device.deviceScaleFactor ?? 1)));
    const contents = this.requireContents(tab.id);
    if (device.name === 'desktop' && device.isMobile !== true) {
      if (this.emulatedTabs.delete(tab.id) && contents.debugger.isAttached()) {
        await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
        assertCurrent();
        await contents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => undefined);
        assertCurrent();
      }
      return { name: 'desktop', width, height, deviceScaleFactor: 1, isMobile: false };
    }
    this.ensureDebugger(contents);
    this.emulatedTabs.add(tab.id);
    await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile: device.isMobile === true,
      screenWidth: width, screenHeight: height,
    });
    assertCurrent();
    await contents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: device.isMobile === true, maxTouchPoints: device.isMobile ? 5 : 1 });
    assertCurrent();
    tab.revision += 1; this.emitState();
    return { name: boundBrowserText(device.name, 128), width, height, deviceScaleFactor, isMobile: device.isMobile === true };
  }

  private respondPermission(id: string, allow: boolean): { ok: true } {
    if (!this.pendingPermission || this.pendingPermission.id !== id) throw new BrowserManagerError('INVALID_REQUEST', 'Permission prompt is no longer active.');
    const pending = this.pendingPermission; this.pendingPermission = null; clearTimeout(pending.timer); pending.respond(allow); return { ok: true };
  }

  private presentDialog(
    tab: BrowserTab,
    prompt: Omit<NonNullable<BrowserState['dialogPrompt']>, 'id' | 'tabId'>,
    responder: (response: DialogResponse) => void,
  ): void {
    this.cancelPendingDialog();
    const id = `dialog_${this.windowPrefix}_${++this.dialogSequence}`;
    let settled = false;
    let timer!: ReturnType<typeof setTimeout>;
    const finish = (response: DialogResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.pendingDialog?.id === id) this.pendingDialog = null;
      if (this.dialogPrompt?.id === id) {
        this.dialogPrompt = null;
        this.emit({ type: 'dialog', prompt: null });
        this.emitState();
      }
      try { responder(response); }
      catch (error) { this.setStatus(tab, `Could not answer browser prompt: ${error instanceof Error ? error.message : String(error)}`); }
    };
    timer = setTimeout(() => finish({ accept: false }), DIALOG_TIMEOUT_MS);
    this.pendingDialog = { id, tabId: tab.id, finish, timer };
    this.dialogPrompt = { id, tabId: tab.id, ...prompt };
    this.selectTab(tab.id);
    this.emit({ type: 'dialog', prompt: { ...this.dialogPrompt } });
    this.emitState();
  }

  private respondDialog(command: Extract<BrowserCommand, { op: 'respond-dialog' }>): { ok: true } {
    const pending = this.pendingDialog;
    if (!pending || pending.id !== command.promptId) throw new BrowserManagerError('INVALID_REQUEST', 'Browser prompt is no longer active.');
    pending.finish({
      accept: command.accept,
      value: boundBrowserText(command.value, 4_096),
    });
    return { ok: true };
  }

  private cancelPendingDialog(tabId?: BrowserTabId): void {
    const pending = this.pendingDialog;
    if (!pending || (tabId && pending.tabId !== tabId)) return;
    pending.finish({ accept: false });
  }

  private async downloadCommand(op: 'open-download' | 'show-download' | 'cancel-download' | 'pause-download' | 'resume-download', id: string): Promise<{ ok: true }> {
    const download = this.downloads.find((entry) => entry.id === id);
    if (!download || this.downloadWorkspaces.get(id) !== this.workspaceRoot) throw new BrowserManagerError('INVALID_REQUEST', 'Download was not found in the active workspace.');
    if (op === 'cancel-download') { this.downloadItems.get(id)?.cancel(); return { ok: true }; }
    if (op === 'pause-download') { this.downloadItems.get(id)?.pause(); return { ok: true }; }
    if (op === 'resume-download') { this.downloadItems.get(id)?.resume(); return { ok: true }; }
    if (!download.savePath) throw new BrowserManagerError('NOT_READY', 'Download has no saved file yet.');
    if (op === 'show-download') shell.showItemInFolder(download.savePath);
    else {
      const error = await shell.openPath(download.savePath);
      if (error) throw new BrowserManagerError('INTERNAL', error);
    }
    return { ok: true };
  }

  /** Reset the browser to a brand-new state: close every tab (which destroys the
   *  per-tab navigation history), wipe the partition's cookies/cache/storage, and
   *  open a single fresh blank tab. This is the user-facing "reset browser". */
  private async resetBrowser(): Promise<{ ok: true }> {
    for (const tab of [...this.tabs]) { try { this.closeTab(tab.id); } catch { /* best effort */ } }
    await this.clearData(['cache', 'cookies', 'storage', 'history']);
    this.permissionGrants.clear();
    this.permissionDecisions.clear();
    if (this.tabs.length === 0) this.createTab(BROWSER_BLANK_URL, true);
    this.persistWorkspace();
    this.emitState();
    return { ok: true };
  }

  private async clearData(types: Array<'cache' | 'cookies' | 'storage' | 'history'> = ['cache']): Promise<{ ok: true }> {
    const ses = session.fromPartition(this.partition);
    if (types.includes('cache')) await ses.clearCache();
    const storages: Array<'cookies' | 'localstorage' | 'indexdb' | 'serviceworkers' | 'cachestorage'> = [];
    if (types.includes('cookies')) storages.push('cookies');
    if (types.includes('storage')) storages.push('localstorage', 'indexdb', 'serviceworkers', 'cachestorage');
    if (storages.length) await ses.clearStorageData({ storages });
    return { ok: true };
  }

  private sendAgentInput(tabId: BrowserTabId, input: Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent): void {
    this.syntheticInputUntil.set(tabId, Date.now() + 100);
    this.requireContents(tabId).sendInputEvent(input);
  }

  private isSyntheticAgentInput(tabId: BrowserTabId): boolean {
    const until = this.syntheticInputUntil.get(tabId) ?? 0;
    if (until >= Date.now()) return true;
    this.syntheticInputUntil.delete(tabId);
    return false;
  }

  private releaseAgentControl(tabId: BrowserTabId): void {
    this.agentNavigationPolicies.delete(tabId);
    this.agentControlledTabs.delete(tabId);
    this.agentDownloadAllowances.delete(tabId);
    this.syntheticInputUntil.delete(tabId);
  }

  private installDownloadListener(): void {
    const browserSession = session.fromPartition(this.partition);
    if (this.downloadListener) return;
    this.downloadListener = (event, item, contents) => {
      const tab = this.tabForContents(contents.id); if (!tab) return;
      const id = `download_${this.windowPrefix}_${++this.downloadSequence}`;
      const filename = safeDownloadName(item.getFilename());
      const agentControlled = this.agentControlledTabs.has(tab.id);
      const gestureExpires = this.agentDownloadAllowances.get(tab.id) ?? 0;
      if (agentControlled && gestureExpires < Date.now()) {
        // A network-tier agent navigation must not turn Content-Disposition
        // into an implicit filesystem write. Only a recent approved computer
        // interaction receives one bounded download opportunity.
        event.preventDefault();
        item.cancel();
        const blocked: BrowserDownload = {
          id, tabId: tab.id, filename, url: boundBrowserText(item.getURL(), 8_192), savePath: null,
          receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'cancelled', startedAt: Date.now(),
        };
        this.downloads.push(blocked);
        this.downloadWorkspaces.set(id, this.workspaceRoot);
        this.trimDownloads();
        this.emitDownload(blocked);
        return;
      }
      if (agentControlled) this.agentDownloadAllowances.delete(tab.id);
      const directory = app.getPath('downloads'); fs.mkdirSync(directory, { recursive: true });
      const savePath = availableDownloadPath(directory, filename); item.setSavePath(savePath);
      const row: BrowserDownload = { id, tabId: tab.id, filename, url: boundBrowserText(item.getURL(), 8_192), savePath, receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'progressing', startedAt: Date.now() };
      this.downloads.push(row); this.downloadWorkspaces.set(id, this.workspaceRoot);
      this.trimDownloads();
      this.downloadItems.set(id, item); this.emitDownload(row);
      item.on('updated', (_e, state) => { row.receivedBytes = item.getReceivedBytes(); row.totalBytes = item.getTotalBytes(); row.state = state === 'interrupted' ? 'interrupted' : 'progressing'; this.emitDownload(row); });
      item.once('done', (_e, state) => { row.receivedBytes = item.getReceivedBytes(); row.totalBytes = item.getTotalBytes(); row.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'; this.downloadItems.delete(id); this.emitDownload(row); });
    };
    browserSession.on('will-download', this.downloadListener);
  }

  private trimDownloads(): void {
    if (this.downloads.length <= 100) return;
    const removed = this.downloads.splice(0, this.downloads.length - 100);
    for (const stale of removed) {
      this.downloadItems.delete(stale.id);
      this.downloadWorkspaces.delete(stale.id);
    }
  }

  private workspaceDownloads(): BrowserDownload[] {
    return this.downloads
      .filter((download) => this.downloadWorkspaces.get(download.id) === this.workspaceRoot)
      .map((download) => ({ ...download }));
  }

  private emitDownload(download: BrowserDownload): void {
    if (this.downloadWorkspaces.get(download.id) === this.workspaceRoot) this.emit({ type: 'download', download: { ...download } });
    this.emitState();
  }

  private showContextMenu(tab: BrowserTab, params: ContextMenuParams): void {
    const contents = this.requireContents(tab.id);
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL && this.isSafeUrl(params.linkURL)) template.push({ label: 'Open link in new tab', click: () => this.createTab(params.linkURL, true) }, { type: 'separator' });
    if (params.isEditable) template.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' });
    else if (params.selectionText) template.push({ role: 'copy' });
    if (template.length) template.push({ type: 'separator' });
    template.push(
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Reload', click: () => contents.reload() },
    );
    if (!app.isPackaged) template.push({ type: 'separator' }, { label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  private handleShortcut(event: { preventDefault(): void }, input: Input): void {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (mod && input.shift && key === 't') { event.preventDefault(); this.reopenTab(); return; }
    if (mod && key === 't') { event.preventDefault(); this.createTab(BROWSER_BLANK_URL, true); return; }
    if (mod && key === 'w') { event.preventDefault(); this.closeTab(this.activeTabId); return; }
    if (mod && key === 'l') { event.preventDefault(); this.win.webContents.focus(); this.emit({ type: 'focus-location', tabId: this.activeTabId }); return; }
    if (mod && key === 'f') { event.preventDefault(); this.win.webContents.focus(); this.emit({ type: 'focus-find', tabId: this.activeTabId }); return; }
    if (mod && key === 'r') { event.preventDefault(); this.requireContents(this.activeTabId).reload(); return; }
    if (mod && /^[1-9]$/.test(key)) { event.preventDefault(); const index = key === '9' ? this.tabs.length - 1 : Number(key) - 1; if (this.tabs[index]) this.selectTab(this.tabs[index].id); return; }
    if (mod && ['+', '=', '-', '0'].includes(key)) {
      event.preventDefault(); const tab = this.activeTab(); const contents = this.requireContents(tab.id); const next = key === '0' ? 1 : contents.getZoomFactor() + (key === '-' ? -0.1 : 0.1); contents.setZoomFactor(Math.min(5, Math.max(0.25, next))); tab.zoomFactor = contents.getZoomFactor(); this.emitState(); return;
    }
    if (input.alt && key === 'left') { event.preventDefault(); const c = this.requireContents(this.activeTabId); if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); return; }
    if (input.alt && key === 'right') { event.preventDefault(); const c = this.requireContents(this.activeTabId); if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); }
  }

  private attachActiveView(): void {
    const active = this.records.get(this.activeTabId);
    const shouldAttach = Boolean(
      active
      && this.surface.visible
      && this.surface.width > 0
      && this.surface.height > 0
      && !active.view.webContents.isDestroyed(),
    );

    // Detach the currently-attached view only if it is no longer the one we want
    // (a real tab switch, or the surface going hidden). Never touch it otherwise
    // — removing + re-adding the same view is exactly what produces the flash.
    const wantId = shouldAttach ? this.activeTabId : null;
    if (this.attachedViewId && this.attachedViewId !== wantId) {
      const prev = this.records.get(this.attachedViewId);
      if (prev) { try { this.win.contentView.removeChildView(prev.view); } catch { /* already detached */ } }
      this.attachedViewId = null;
    }

    if (!shouldAttach || !active) return;

    // Bounds updates are smooth (no flash), so always apply them.
    active.view.setBounds({ x: this.surface.x, y: this.surface.y, width: this.surface.width, height: this.surface.height });
    // Add to the window tree only when it isn't already there.
    if (this.attachedViewId !== this.activeTabId) {
      this.win.contentView.addChildView(active.view);
      this.attachedViewId = this.activeTabId;
    }
  }

  private safeUrl(raw: string): string {
    const normalized = raw === BROWSER_BLANK_URL ? raw : normalizeBrowserAddress(raw);
    if (!normalized || !this.isSafeUrl(normalized)) throw new BrowserManagerError('UNSAFE_URL', 'The browser refused an unsafe or invalid URL.');
    return normalized;
  }

  private isSafeUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.username || parsed.password)) return false;
      if (parsed.protocol === 'file:') {
        const root = fs.realpathSync(this.workspaceRoot);
        const target = fs.realpathSync(fileURLToPath(parsed));
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
      }
    } catch {
      return false;
    }
    return isAllowedWebviewSrc(url, this.workspaceRoot);
  }

  private resolveTab(id?: string, required = true): BrowserTab | null {
    const wanted = id || this.activeTabId;
    const tab = this.tabs.find((entry) => entry.id === wanted) ?? null;
    if (!tab && required) throw new BrowserManagerError('TAB_NOT_FOUND', `Browser tab ${wanted || '(active)'} was not found.`);
    return tab;
  }

  private requireTab(tab: BrowserTab | null): BrowserTab {
    if (!tab) throw new BrowserManagerError('TAB_NOT_FOUND', 'No active browser tab exists.');
    return tab;
  }

  private activeTab(): BrowserTab {
    return this.requireTab(this.resolveTab());
  }

  private requireContents(id: string): WebContents {
    const contents = this.records.get(id)?.view.webContents;
    if (!contents || contents.isDestroyed()) throw new BrowserManagerError('TAB_NOT_FOUND', `Browser tab ${id} is closed.`);
    return contents;
  }

  private tabForContents(contentsId: number): BrowserTab | null {
    for (const tab of this.tabs) if (this.records.get(tab.id)?.view.webContents.id === contentsId) return tab;
    return null;
  }

  private validateRef(tab: BrowserTab, ref?: string): void {
    if (!ref) return;
    if (!isOpaqueBrowserRef(ref)) throw new BrowserManagerError('INVALID_REQUEST', 'Element reference is invalid.');
    const prefix = `br:${tab.id}:${tab.revision}:`;
    if (!ref.startsWith(prefix)) throw new BrowserManagerError('STALE_PAGE', 'Element reference belongs to a different tab or page revision. Take a new snapshot.');
  }

  private isolated<T = unknown>(tabId: string, code: string): Promise<T> {
    return this.requireContents(tabId).executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }], true) as Promise<T>;
  }

  private ensureDebugger(contents: WebContents): boolean {
    if (contents.debugger.isAttached()) return false;
    contents.debugger.attach('1.3');
    void contents.debugger.sendCommand('Page.enable').catch(() => undefined);
    return true;
  }

  private updateHumanChallenge(tab: BrowserTab): void {
    const reason = humanChallengeReason(tab.url, tab.title);
    if (!reason) {
      this.humanChallengeTabs.delete(tab.id);
      return;
    }
    if (this.humanChallengeTabs.has(tab.id)) return;
    this.humanChallengeTabs.add(tab.id);
    this.releaseAgentControl(tab.id);
    this.selectTab(tab.id);
    this.setStatus(tab, `${reason} Complete it in this visible tab; the agent will remain paused.`);
  }

  private setStatus(tab: BrowserTab, text: string): void {
    this.emit({ type: 'status', tabId: tab.id, text: boundBrowserText(text, 1_024) });
  }

  private findInPage(tab: BrowserTab, text: string, forward = true, findNext = false): Promise<{ requestId: number; activeMatchOrdinal?: number; matches?: number }> {
    const contents = this.requireContents(tab.id);
    return new Promise((resolve) => {
      let requestId = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onFound = (_event: unknown, result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }): void => {
        if (settled || result.requestId !== requestId || !result.finalUpdate) return;
        settled = true;
        if (timer) clearTimeout(timer);
        contents.removeListener('found-in-page', onFound);
        resolve({ requestId, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
      };
      contents.on('found-in-page', onFound);
      requestId = contents.findInPage(text, { forward, findNext });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        contents.removeListener('found-in-page', onFound);
        resolve({ requestId });
      }, 750);
    });
  }

  private emit(event: BrowserEvent): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('browser:event', event);
  }

  private emitState(): void {
    if (this.stateEmitQueued || this.disposed) return;
    this.stateEmitQueued = true;
    queueMicrotask(() => { this.stateEmitQueued = false; if (!this.disposed) this.emit({ type: 'state', state: this.getState() }); });
  }

  private enqueue<T>(tabId: string, operation: () => { result: Promise<T>; settled: Promise<void> }): Promise<T> {
    const before = this.queues.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const chain = before.then(() => next);
    this.queues.set(tabId, chain);
    return before.then(() => {
      try {
        const started = operation();
        void started.settled.finally(() => {
          release();
          if (this.queues.get(tabId) === chain) this.queues.delete(tabId);
        });
        return started.result;
      } catch (error) {
        release();
        if (this.queues.get(tabId) === chain) this.queues.delete(tabId);
        throw error;
      }
    });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs = 30_000, signal?: AbortSignal, onCancel?: () => void): Promise<T> {
    const bounded = Math.min(120_000, Math.max(1, Math.floor(timeoutMs)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    if (signal?.aborted) {
      onCancel?.();
      throw new BrowserManagerError('CANCELLED', 'Browser command was cancelled.');
    }
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => { onCancel?.(); reject(new BrowserManagerError('TIMEOUT', `Browser command timed out after ${bounded} ms.`)); }, bounded);
          abortListener = () => { onCancel?.(); reject(new BrowserManagerError('CANCELLED', 'Browser command was cancelled.')); };
          signal?.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    }
  }

  private failure(id: string, code: BrowserErrorCode, error: string, tab?: BrowserTab | null): BrowserCommandResult {
    return { ok: false, requestId: boundBrowserText(id, 128), code, error: boundBrowserText(error, 1_024), ...(tab ? { tabId: tab.id, revision: tab.revision } : {}) };
  }

  private persistencePath(): string {
    const key = createHash('sha256').update(this.workspaceRoot).digest('hex').slice(0, 20);
    return path.join(app.getPath('userData'), 'browser-tabs-v1', `${key}.json`);
  }

  private restoreWorkspace(): void {
    let persisted: PersistedTabs | null = null;
    try { persisted = JSON.parse(fs.readFileSync(this.persistencePath(), 'utf8')) as PersistedTabs; } catch { persisted = null; }
    const rows = persisted?.version === 1 && Array.isArray(persisted.tabs) ? persisted.tabs.slice(0, MAX_BROWSER_TABS) : [];
    for (const row of rows) {
      const raw = typeof row.url === 'string' && !row.url.startsWith('data:') ? row.url : BROWSER_BLANK_URL;
      try { this.createTab(raw, false); } catch { /* skip unsafe/stale row */ }
    }
    const decisions = persisted?.version === 1 && Array.isArray(persisted.permissions)
      ? persisted.permissions.slice(0, 200)
      : [];
    for (const row of decisions) {
      if (row?.permission !== 'geolocation' || (row.decision !== 'allow' && row.decision !== 'block')) continue;
      let origin = '';
      try {
        const parsed = new URL(row.origin);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        origin = parsed.origin;
      } catch { continue; }
      const key = `${origin}\ngeolocation`;
      this.permissionDecisions.set(key, row.decision);
      if (row.decision === 'allow') this.permissionGrants.add(key);
    }
    if (this.tabs.length > 0) this.selectTab(this.tabs[Math.max(0, Math.min(this.tabs.length - 1, Math.floor(persisted?.activeIndex ?? 0)))].id);
  }

  private persistWorkspace(): void {
    if (this.disposed || !this.workspaceRoot) return;
    const state: PersistedTabs = {
      version: 1,
      activeIndex: Math.max(0, this.tabs.findIndex((tab) => tab.id === this.activeTabId)),
      tabs: this.tabs.map((tab) => ({ url: persistableBrowserUrl(tab.url) })),
      permissions: [...this.permissionDecisions.entries()].slice(-200).map(([key, decision]) => ({
        origin: key.slice(0, key.lastIndexOf('\n')),
        permission: 'geolocation',
        decision,
      })),
    };
    try {
      const file = this.persistencePath(); fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file);
    } catch { /* best effort */ }
  }

  private destroyView(id: string): void {
    const record = this.records.get(id); if (!record) return;
    this.cancelPendingDialog(id);
    if (this.pendingPermission?.tabId === id) {
      const pending = this.pendingPermission;
      this.pendingPermission = null;
      clearTimeout(pending.timer);
      pending.cancel();
    }
    try { this.win.contentView.removeChildView(record.view); } catch { /* detached */ }
    if (this.attachedViewId === id) this.attachedViewId = null;
    this.humanChallengeTabs.delete(id);
    managersByWebContents.delete(record.view.webContents.id);
    this.releaseAgentControl(id);
    this.cleanupStagedUpload(id);
    this.pendingAuthPrompts.get(id)?.abort();
    this.pendingAuthPrompts.delete(id);
    this.emulatedTabs.delete(id);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    this.records.delete(id); this.queues.delete(id);
  }

  private destroyAllViews(): void {
    for (const id of [...this.records.keys()]) this.destroyView(id);
  }
}
