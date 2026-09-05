import {
  app,
  Menu,
  session,
  shell,
  clipboard,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type Session,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedWebviewSrc } from '../webviewPolicy.js';
import { browserPermissionCheckScopes, browserPermissionRequestScope } from './browserPermissionPolicy.js';
import {
  recordUserPrivateOriginTrust,
  resolvedBrowserDestinationAllowed,
  type BrowserHostResolver,
} from './browserDestinationPolicy.js';
import { agentCursorScript, removeAgentCursorScript } from './browserCursor.js';
import { humanChallengeReason } from './browserHumanChallenge.js';
import {
  browserAcceptLanguages,
  browserPartitionForWorkspace,
  standardChromeUserAgent,
} from './browserProfile.js';
import { promptForHttpAuth } from './httpAuthPrompt.js';
import { BrowserManagerError } from './browserManagerError.js';
import { BrowserPromptManager } from './browserPromptManager.js';
import { agentDownloadDir, browserPrintDir, workspaceRelativeDownloadPath, safeName } from '../browserSafety.js';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import {
  availableDownloadPath,
  BrowserDownloadManager,
} from './browserDownloadManager.js';
import { BrowserNativeViewManager } from './browserNativeViewManager.js';
import { BrowserTabStateManager } from './browserTabStateManager.js';
import {
  stageWorkspaceUploadFiles,
  UploadStagingError,
} from './uploadStaging.js';
import {
  BrowserWorkspacePersistenceQueue,
  BrowserWorkspaceStore,
  addBrowserBookmark,
  removeBrowserBookmark,
  recordBrowserVisit,
  omniboxSuggest,
  MAX_BROADCAST_BOOKMARKS,
  type BrowserBookmark,
  type BrowserHistoryEntry,
  persistableBrowserUrl,
  type PersistedBrowserWorkspace,
} from './browserWorkspaceStore.js';
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
const MAX_NETWORK_ROWS = 500;
const DIALOG_TIMEOUT_MS = 60_000;
const AGENT_DOWNLOAD_GESTURE_MS = 5_000;
const STAGED_UPLOAD_TTL_MS = 30 * 60_000;
const AGENT_DOWNLOAD_INTERACTIONS = new Set<BrowserCommand['op']>([
  'click', 'double-click', 'type', 'press', 'drag', 'select', 'check', 'set-files', 'respond-dialog',
]);

type AgentNavigationPolicy = { allowedPrivateOrigin?: string };
type StagedUpload = { directory: string; timer: ReturnType<typeof setTimeout> };
type BrowserOperationGuard = () => void;

const managersByWebContents = new Map<number, BrowserViewManager>();
const configuredSessions = new WeakSet<Session>();

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
    void (manager?.destinationAllowedForRequest(details.webContentsId, details.url) ?? resolvedBrowserDestinationAllowed(details.url))
      .then((allow) => callback({ cancel: !allow }), () => callback({ cancel: true }));
  });
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
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

function designAuditScript(rules: string[], max: number): string {
  return `(() => {
    const RULES = new Set(${JSON.stringify(rules)}); const MAX = ${max};
    const want = (id) => RULES.size === 0 || RULES.has(id);
    const out = [];
    const text = (el) => String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const sel = (el) => { const parts = []; let n = el; let depth = 0; while (n && n.nodeType === 1 && depth < 4) { let s = n.tagName.toLowerCase(); if (n.id) { parts.unshift(s + '#' + n.id); break; } const cls = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : ''; if (cls) s += '.' + cls; parts.unshift(s); n = n.parentElement; depth++; } return parts.join(' > '); };
    const push = (rule, el, message) => { if (out.length >= MAX) return; const r = el.getBoundingClientRect(); out.push({ rule, message, selector: sel(el), snippet: text(el).slice(0, 60), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }); };
    const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = (el) => { const layers = []; let n = el; while (n && n.nodeType === 1) { const s = getComputedStyle(n); if (s.backgroundImage && s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0) layers.push(c); if (c && c.a >= 1) break; n = n.parentElement; } let r = 255, g = 255, b = 255; for (let i = layers.length - 1; i >= 0; i--) { const c = layers[i]; r = c.r * c.a + r * (1 - c.a); g = c.g * c.a + g * (1 - c.a); b = c.b * c.a + b * (1 - c.a); } return { r, g, b }; };
    const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const hasOwnText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && String(n.textContent).trim().length > 0);
    const root = document.documentElement; const vw = innerWidth;
    if (want('horizontal-overflow') && root.scrollWidth > vw + 1) push('horizontal-overflow', root, 'The page scrolls horizontally in the first viewport: content is ' + (root.scrollWidth - vw) + 'px wider than the ' + vw + 'px viewport.');
    const els = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 4000);
    for (const el of els) {
      if (out.length >= MAX) break;
      if (!(el instanceof HTMLElement)) continue;
      const s = getComputedStyle(el);
      if (want('small-touch-target') && visible(el) && el.matches('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]')) { const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 24) push('small-touch-target', el, 'Interactive target ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px is under 24px.'); }
      if (!hasOwnText(el)) continue;
      const fs = parseFloat(s.fontSize) || 0; const t = text(el);
      if (want('hidden-at-rest')) { const op = parseFloat(s.opacity); const tp = String(s.transitionProperty || ''); if ((op === 0 || s.visibility === 'hidden') && /opacity|visibility|all/.test(tp) && t.length >= 3) push('hidden-at-rest', el, 'Content is invisible at rest and only appears through a transition (hover/focus reveal).'); }
      if (!visible(el)) continue;
      if (want('tiny-text') && fs > 0 && fs < 12 && t.length >= 20) push('tiny-text', el, 'Computed font-size ' + fs + 'px on body copy.');
      if (want('low-contrast')) { const fg = parse(s.color); const bg = bgOf(el); if (fg && bg && fg.a > 0.99) { const r = ratio(fg, bg); const large = fs >= 24 || (fs >= 18.66 && parseInt(s.fontWeight, 10) >= 700); const min = large ? 3 : 4.5; if (r < min) push('low-contrast', el, 'Contrast ' + r.toFixed(2) + ':1 against the composited background (needs ' + min + ':1).'); } }
      if (want('text-overflow')) { const clipped = el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(s.overflowX + ' ' + s.overflow); const r = el.getBoundingClientRect(); let occluded = false; if (!clipped && r.width > 0 && r.top >= 0 && r.top < innerHeight) { const cx = Math.min(innerWidth - 1, r.left + r.width / 2), cy = Math.min(innerHeight - 1, r.top + Math.min(r.height, 24) / 2); const top = document.elementFromPoint(cx, cy); occluded = !!top && top !== el && !el.contains(top) && !top.contains(el); } if (clipped || occluded) push('text-overflow', el, clipped ? 'Text is clipped: ' + el.scrollWidth + 'px of content in a ' + el.clientWidth + 'px box with overflow hidden.' : 'Text is covered by another element at its centre.'); }
    }
    return { url: location.href, viewport: { width: innerWidth, height: innerHeight }, scanned: els.length, findings: out, truncated: out.length >= MAX };
  })()`;
}

function semanticSnapshotScript(tabId: string, revision: number, scope: 'viewport' | 'page' = 'viewport'): string {
  return `(() => {
    const SCOPE = ${JSON.stringify(scope)};
    const roleFor = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox',NAV:'navigation',MAIN:'main',HEADER:'banner',FOOTER:'contentinfo',H1:'heading',H2:'heading',H3:'heading',IMG:'img'})[el.tagName] || '';
    const styleVisible = (el) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity||1)>0; };
    const inViewport = (el) => { const r=el.getBoundingClientRect(); return r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth; };
    const nameFor = (el) => String(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,200);
    const valueIsSensitive = (el,type) => {
      if (['password','hidden','file'].includes(type)) return true;
      const autocomplete=String(el.getAttribute('autocomplete')||'').toLowerCase();
      if (/(?:current|new)-password|cc-(?:number|csc|exp)|one-time-code/.test(autocomplete)) return true;
      const identity=String([el.id,el.getAttribute('name'),el.getAttribute('data-testid'),el.getAttribute('aria-label')].filter(Boolean).join(' ')).toLowerCase();
      return /(?:^|[^a-z])(password|passwd|secret|token|csrf|xsrf|session|authorization|api.?key|card.?number|credit.?card|cvv|cvc|csc|otp)(?:[^a-z]|$)/.test(identity);
    };
    const SELECTOR='a,button,input,textarea,select,option,summary,nav,main,header,footer,[role],[data-testid],h1,h2,h3,img';
    // ADR-055 P3 — walk open shadow roots too, so a control inside a web
    // component is observable. Bounded + guarded: a failing subtree degrades to
    // the light DOM rather than breaking the whole snapshot.
    const collectDeep = (root, depth, acc) => {
      if (depth>6 || acc.length>=3000) return acc;
      try { for (const el of root.querySelectorAll(SELECTOR)) { acc.push(el); if (acc.length>=3000) return acc; } } catch (e) {}
      try { for (const host of root.querySelectorAll('*')) { if (host.shadowRoot) { collectDeep(host.shadowRoot, depth+1, acc); if (acc.length>=3000) return acc; } } } catch (e) {}
      return acc;
    };
    const all=collectDeep(document, 0, []).slice(0,2500);
    const nodes = new Map(); const rows=[];
    let index=0;
    for (const el of all) {
      const vis=styleVisible(el), role=roleFor(el), testid=(el.getAttribute&&el.getAttribute('data-testid'))||'';
      if (!role && !testid) continue;
      // Hidden DOM content is never an observation surface (it also stops hidden
      // data-testid/ARIA/placeholder/text nodes from leaking application secrets).
      if (!vis) continue;
      const within=inViewport(el);
      // ADR-055 P3 — scope 'page' keeps scrolled-out (but visible) nodes so the
      // model need not scroll-and-re-snapshot; 'viewport' (default) is the old
      // behaviour. Off-DOM/hidden nodes stay excluded in BOTH scopes.
      if (SCOPE!=='page' && !within) continue;
      const ref='br:${tabId}:${revision}:node_'+(++index); nodes.set(ref,el);
      const r=el.getBoundingClientRect(), type=String((el.getAttribute&&el.getAttribute('type'))||'').slice(0,40);
      const valueBearing=(el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement||(el instanceof HTMLInputElement&&['','text','search','email','url','tel','number','range','date','time','month','week','datetime-local','color'].includes(type)));
      rows.push({ref,role,name:nameFor(el),tag:(el.tagName||'').toLowerCase(),testid:testid||undefined,type:type||undefined,
        value:!valueBearing||valueIsSensitive(el,type)?undefined:String(el.value||'').slice(0,200),
        checked:typeof el.checked==='boolean'?el.checked:undefined,selected:typeof el.selected==='boolean'?el.selected:undefined,
        disabled:typeof el.disabled==='boolean'?el.disabled:undefined,visible:vis,inViewport:within,rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
      if(rows.length>=${MAX_BROWSER_ROWS}) break;
    }
    window.__brainrouterAgentRefs={revision:${revision},nodes};
    return {url:location.href,title:document.title,scope:SCOPE,nodes:rows};
  })()`;
}

function pointHitScript(x: number, y: number): string {
  // ADR-055 P2 — resolve the element under a screenshot-frame point (viewport
  // CSS pixels), report its role/name for the receipt, and flag a credential
  // field so the caller refuses a coordinate action on it. Mirrors the
  // snapshot's valueIsSensitive rule (form controls only) so a coordinate click
  // is no less safe, without over-refusing ordinary buttons/links.
  return `(() => {
    const roleFor = (el) => (el.getAttribute && el.getAttribute('role')) || ({A:'link',BUTTON:'button',INPUT:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),TEXTAREA:'textbox',SELECT:'combobox'}[el.tagName]||'');
    const nameFor = (el) => String((el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')))||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,200);
    // A credential field is a value-bearing FORM CONTROL only. The identity
    // regex must never gate an ordinary button/link/div whose id or aria-label
    // merely contains a word like "session"/"token" — that would refuse
    // clicking a "Log out" (id="session-end") button. This mirrors the
    // snapshot's valueIsSensitive, which only ever applies to form inputs.
    const isFormControl = (el) => !!el && ['INPUT','TEXTAREA','SELECT'].includes((el.tagName||'').toUpperCase());
    const isSensitive = (el) => {
      if (!isFormControl(el) || !el.getAttribute) return false;
      const type=String(el.getAttribute('type')||'').toLowerCase();
      if (['password','hidden'].includes(type)) return true;
      const ac=String(el.getAttribute('autocomplete')||'').toLowerCase();
      if (/(?:current|new)-password|cc-(?:number|csc|exp)|one-time-code/.test(ac)) return true;
      const id=String([el.id,el.getAttribute('name'),el.getAttribute('aria-label')].filter(Boolean).join(' ')).toLowerCase();
      return /(?:^|[^a-z])(password|passwd|secret|token|csrf|xsrf|session|authorization|api.?key|card.?number|credit.?card|cvv|cvc|csc|otp)(?:[^a-z]|$)/.test(id);
    };
    const el=document.elementFromPoint(${x}, ${y});
    if(!el) return {ok:false};
    // Only a form control under the point can be a credential field; a plain
    // element (button/link/div) is never refused.
    const control=(el.closest && el.closest('input,textarea,select'))||(isFormControl(el)?el:null);
    const r=el.getBoundingClientRect();
    return {ok:true, sensitive: isSensitive(control),
      element:{role:roleFor(el)||'', name:nameFor(el), tag:(el.tagName||'').toLowerCase(), type:String((el.getAttribute&&el.getAttribute('type'))||'')||undefined},
      rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
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
  private surface: BrowserSurface = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private readonly windowPrefix = randomUUID().replace(/-/g, '').slice(0, 10);
  private readonly tabState: BrowserTabStateManager;
  private readonly nativeViews: BrowserNativeViewManager;
  // One persistent profile per workspace preserves sign-ins, cookies, storage,
  // and completed site challenges across chat sessions without sharing them
  // with another workspace.
  private partition: string;
  private workspaceStore: BrowserWorkspaceStore;
  private sessionKey: string | null = null;
  private readonly queues = new Map<BrowserTabId, Promise<void>>();
  private readonly emulatedTabs = new Set<BrowserTabId>();
  // When true, agent pointer actions (click/hover/drag) glide a visible cursor
  // overlay to the target and pulse a ripple on click, so a human watching the
  // pane SEES the agent operate the page. Toggled by the panel's set-cursor op;
  // defaults on so the cursor shows even before the renderer syncs the toggle.
  private agentCursorEnabled = true;
  private readonly promptManager: BrowserPromptManager;
  private readonly downloadManager: BrowserDownloadManager;
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
  // ADR-055 P9 — the workspace's saved places and visit history.
  private bookmarks: BrowserBookmark[] = [];
  private history: BrowserHistoryEntry[] = [];
  /** Last url recorded per tab, so one page load counts as one visit. */
  private readonly lastHistoryUrl = new Map<BrowserTabId, string>();
  /** ADR-055 P10 — the tab currently in HTML5 fullscreen (a video), if any. */
  private htmlFullscreenTabId: BrowserTabId | null = null;
  /** ADR-055 P7 — tabs the person handed to the current chat's agent. */
  private readonly sharedTabs = new Set<BrowserTabId>();
  private tabShareHandler: ((info: { workspaceRoot: string; sessionKey: string; tabId: BrowserTabId; share: boolean }) => void) | null = null;
  private readonly trustedUserPrivateOrigins = new Set<string>();
  private readonly userOriginChecks = new Map<string, Promise<void>>();
  private readonly syntheticInputUntil = new Map<BrowserTabId, number>();
  private readonly stagedUploads = new Map<BrowserTabId, StagedUpload>();
  private readonly pendingAuthPrompts = new Map<BrowserTabId, AbortController>();
  private readonly rawSettlements = new Map<string, Promise<void>>();
  private stateEmitQueued = false;
  private disposed = false;
  private workspaceGeneration = 0;
  private readonly workspacePersistence: BrowserWorkspacePersistenceQueue;

  constructor(private readonly win: BrowserWindow, workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.partition = browserPartitionForWorkspace(workspaceRoot);
    this.tabState = new BrowserTabStateManager(this.windowPrefix);
    this.nativeViews = new BrowserNativeViewManager({
      createView: (partition) => new WebContentsView({
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          safeDialogs: true,
          safeDialogsMessage: 'Additional dialogs from this page were blocked.',
          // Never timer-throttle the browser view. A WebContentsView's
          // occlusion can be mis-detected under the renderer overlay, and
          // throttling an active tab stalls JS-heavy sites and login flows.
          backgroundThrottling: false,
          spellcheck: true,
          // ADR-055 P10 — Chromium's built-in PDF viewer, so a PDF opens IN the
          // tab like every other browser instead of becoming a download.
          plugins: true,
        },
      }),
      attachView: (view) => { this.win.contentView.addChildView(view); },
      detachView: (view) => { this.win.contentView.removeChildView(view); },
    });
    this.workspaceStore = new BrowserWorkspaceStore(app.getPath('userData'), workspaceRoot);
    this.workspacePersistence = new BrowserWorkspacePersistenceQueue(
      () => this.writeWorkspaceState(),
    );
    this.promptManager = new BrowserPromptManager({
      tabForContents: (contentsId) => this.tabForContents(contentsId),
      selectTab: (tabId) => { this.selectTab(tabId); },
      persist: () => { this.persistWorkspace(); },
      emit: (event) => { this.emit(event); },
      emitState: () => { this.emitState(); },
      setStatus: (tab, text) => { this.setStatus(tab, text); },
    }, this.windowPrefix);
    this.downloadManager = new BrowserDownloadManager({
      listen: (partition, listener) => {
        const browserSession = session.fromPartition(partition);
        const handler = (
          event: Electron.Event,
          item: Electron.DownloadItem,
          contents: WebContents,
        ): void => {
          listener(event, item, contents.id);
        };
        browserSession.on('will-download', handler);
        return () => { browserSession.off('will-download', handler); };
      },
      prepareSavePath: (filename, agentControlled) => {
        // ADR-055 P8 — an agent-initiated download lands in the workspace inbox
        // so the agent's workspace-jailed file tools can read it; a human
        // download keeps the ordinary OS Downloads folder.
        const directory = agentControlled ? agentDownloadDir(workspaceRoot) : app.getPath('downloads');
        fs.mkdirSync(directory, { recursive: true });
        return availableDownloadPath(directory, filename);
      },
      showItemInFolder: (savePath) => { shell.showItemInFolder(savePath); },
      openPath: async (savePath) => await shell.openPath(savePath),
    }, {
      tabForContents: (contentsId) => this.tabForContents(contentsId),
      isAgentControlled: (tabId) => this.agentControlledTabs.has(tabId),
      emit: (event) => { this.emit(event); },
      emitState: () => { this.emitState(); },
    }, this.windowPrefix, workspaceRoot, this.partition);
    configureBrowserSession(session.fromPartition(this.partition));
    this.restoreWorkspace();
    if (this.tabState.length === 0) this.createTab(BROWSER_BLANK_URL, true);
  }

  getState(): BrowserState {
    return {
      version: BROWSER_PROTOCOL_VERSION,
      activeTabId: this.tabState.activeTabId,
      tabs: this.humanChallengeTabs.size === 0 && this.sharedTabs.size === 0
        ? this.tabState.snapshot()
        : this.tabState.snapshot().map((t) => ({
          ...t,
          ...(this.humanChallengeTabs.has(t.id) ? { humanNeeded: true } : {}),
          ...(this.sharedTabs.has(t.id) ? { sharedWithAgent: true } : {}),
        })),
      closedTabCount: this.tabState.closedCount,
      surface: { ...this.surface },
      downloads: this.downloadManager.list(),
      permissionPrompt: this.promptManager.getPermissionPrompt(),
      dialogPrompt: this.promptManager.getDialogPrompt(),
      bookmarks: this.bookmarks.slice(0, MAX_BROADCAST_BOOKMARKS),
      fullscreenTabId: this.htmlFullscreenTabId,
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
      // A panel switch/unmount is explicit user takeover. Native views render
      // above every renderer pixel, so deferring this hide lets the Browser
      // cover Settings/Atlas/Editor until Chromium settles. Detach first, then
      // abort the action; the operation guard prevents a late side effect.
      this.visibleAgentPin.deferredSurface = undefined;
      this.visibleAgentPin.userTakeoverRequested = true;
      this.surface = next;
      this.attachActiveView();
      this.emitState();
      this.agentTakeoverHandler?.();
      return { ...next };
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
    return this.nativeViews.isTabVisible(
      tabId,
      this.tabState.activeTabId,
      this.surface,
    );
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
    return resolvedBrowserDestinationAllowed(url, policy, async (host, fresh) => {
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
            'This site requires human verification. It is shown in the visible Browser tab for the person to complete. Call browser_wait with human:true to wait for them to finish, then continue.',
          );
        }
        if (signal && tab) {
          this.agentControlledTabs.add(tab.id);
          if (AGENT_DOWNLOAD_INTERACTIONS.has(request.command.op)) {
            this.downloadManager.allowAgentInteraction(
              tab.id,
              Date.now() + AGENT_DOWNLOAD_GESTURE_MS,
            );
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
        this.promptManager.stopForTab(current.id);
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
    const queueTab = request.tabId ?? this.tabState.activeTabId;
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
    this.workspaceGeneration += 1;
    this.visibleAgentPin = null;
    this.persistWorkspace();
    this.destroyAllViews();
    this.workspaceRoot = workspaceRoot;
    this.partition = browserPartitionForWorkspace(workspaceRoot);
    this.workspaceStore = new BrowserWorkspaceStore(app.getPath('userData'), workspaceRoot);
    this.downloadManager.setWorkspace(workspaceRoot, this.partition);
    this.sessionKey = null;
    this.tabState.reset();
    this.trustedUserPrivateOrigins.clear();
    this.userOriginChecks.clear();
    this.humanChallengeTabs.clear();
    configureBrowserSession(session.fromPartition(this.partition));
    this.restoreWorkspace();
    if (this.tabState.length === 0) this.createTab(BROWSER_BLANK_URL, true);
    this.attachActiveView();
    this.emitState();
  }

  /** Record the active chat without rotating the workspace browser profile.
   * Browser tabs, sign-ins, cookies, and completed challenges intentionally
   * remain continuous across chats in the same workspace. */
  setSession(sessionKey: string | null): void {
    // ADR-055 P7 — a share is per-chat: switching chats revokes every grant the
    // previous chat held, so a new chat never inherits a shared human tab.
    if (this.sessionKey !== sessionKey && this.sharedTabs.size > 0) {
      for (const tabId of [...this.sharedTabs]) this.notifyShare(tabId, false);
      this.sharedTabs.clear();
    }
    this.sessionKey = sessionKey;
  }

  /** Compatibility operation for chat deletion. Browser state is workspace
   * scoped, so deleting one chat must not sign every other chat out. Users can
   * explicitly clear or reset the workspace browser from the Browser panel. */
  async clearSessionData(sessionKey: string): Promise<void> {
    if (this.sessionKey === sessionKey) this.sessionKey = null;
  }

  hasPermission(rawOrigin: string, grants: string[]): boolean {
    return this.promptManager.hasPermission(rawOrigin, grants);
  }

  requestPermission(contentsId: number, permission: string, grants: string[], rawOrigin: string, callback: (allow: boolean) => void): void {
    this.promptManager.requestPermission(
      contentsId,
      permission,
      grants,
      rawOrigin,
      callback,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.persistWorkspace();
    this.disposed = true;
    this.promptManager.dispose();
    this.downloadManager.dispose();
    this.destroyAllViews();
    this.agentNavigationPolicies.clear();
    this.agentControlledTabs.clear();
    this.trustedUserPrivateOrigins.clear();
    this.userOriginChecks.clear();
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
    const reapable = this.tabState.all().filter(
      (tab) =>
        this.agentControlledTabs.has(tab.id)
        && tab.id !== this.tabState.activeTabId,
    );
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
    const url = this.safeUrl(rawUrl);
    // Reject overflow before allocating a native view so a failed open cannot
    // leave an untracked WebContentsView behind.
    this.tabState.ensureCanCreate();
    const { tab, contents } = this.nativeViews.create(
      this.partition,
      () => this.tabState.create(url, options?.title),
    );
    const id = tab.id;
    if (options?.agentControlled) {
      this.agentNavigationPolicies.set(id, options.agentPolicy ?? {});
      this.agentControlledTabs.add(id);
    }
    managersByWebContents.set(contents.id, this);
    this.wireView(tab, contents);
    if (active || !this.tabState.activeTabId) this.selectTab(id);
    if (!options?.deferLoad) void contents.loadURL(url).catch((error) => {
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
      if (!this.agentControlledTabs.has(tab.id)) {
        void this.recordUserPrivateOrigin(tab.url);
        this.noteVisit(tab);
      }
      tab.revision += 1;
      this.workspacePersistence.schedule();
      this.emitState();
    };
    const gate = (event: { preventDefault(): void }, url: string): void => {
      if (!this.isSafeUrl(url)) {
        event.preventDefault();
        this.setStatus(tab, `Blocked unsafe navigation to ${boundBrowserText(url, 256)}`);
      }
    };
    this.nativeViews.wire(tab.id, {
      gate,
      updateNavigation,
      startLoading: () => {
        tab.loading = true;
        this.emitState();
      },
      stopLoading: () => {
        tab.loading = false;
        updateNavigation();
      },
      updateTitle: (title) => {
        tab.title = boundBrowserText(title || 'New tab', 256);
        this.updateHumanChallenge(tab);
        if (!this.agentControlledTabs.has(tab.id)) this.refreshVisitTitle(tab);
        this.workspacePersistence.schedule();
        this.emitState();
      },
      updateFavicons: (favicons) => {
        tab.faviconUrl = favicons.find(
          (value) => /^https?:|^data:image\//i.test(value),
        ) ?? null;
        this.emitState();
      },
      enterHtmlFullScreen: () => {
        this.htmlFullscreenTabId = tab.id;
        this.attachActiveView();
        this.emitState();
      },
      leaveHtmlFullScreen: () => {
        if (this.htmlFullscreenTabId === tab.id) this.htmlFullscreenTabId = null;
        this.attachActiveView();
        this.emitState();
      },
      mediaStarted: () => {
        tab.audible = true;
        this.emitState();
      },
      mediaPaused: () => {
        tab.audible = false;
        this.emitState();
      },
      renderProcessGone: (reason) => {
        tab.crashed = true;
        tab.loading = false;
        this.setStatus(tab, `Tab crashed (${reason}). Reload to recover.`);
        this.emitState();
      },
      loadFailed: (code, description, validatedUrl, isMainFrame) => {
        if (!isMainFrame || code === -3) return;
        tab.loading = false;
        this.setStatus(
          tab,
          `Load failed: ${description} (${boundBrowserText(validatedUrl, 512)})`,
        );
        this.emitState();
      },
      consoleMessage: (details) => {
        this.nativeViews.recordConsole(tab.id, {
          level: details.level,
          text: boundBrowserText(details.message, 4_096),
          source: boundBrowserText(details.sourceId, 512),
          line: details.lineNumber,
          at: Date.now(),
        });
      },
      beforeInput: (event, input) => {
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
      },
      beforeMouse: (event) => {
        if (!this.isSyntheticAgentInput(tab.id)) {
          if (this.visibleAgentPin?.tabId === tab.id) {
            event.preventDefault();
            this.visibleAgentPin.userTakeoverRequested = true;
            this.agentTakeoverHandler?.();
            return;
          }
          this.releaseAgentControl(tab.id);
        }
      },
      contextMenu: (params) => {
        this.showContextMenu(tab, params);
      },
      login: (event, authenticationResponseDetails, authInfo, callback) => {
        event.preventDefault();
        if (authInfo.isProxy) {
          // Proxy credentials are deliberately unsupported: presenting the
          // destination origin for a 407 challenge can trick a user into
          // sending site credentials to an intermediary.
          this.setStatus(
            tab,
            `Proxy authentication was blocked for ${boundBrowserText(`${authInfo.host}:${authInfo.port}`, 512)}.`,
          );
          callback();
          return;
        }
        let origin = authenticationResponseDetails.url;
        try {
          origin = new URL(authenticationResponseDetails.url).origin;
        } catch {
          // Retain the bounded URL.
        }
        const realm = boundBrowserText(
          authInfo.realm || authInfo.scheme || 'this site',
          256,
        );
        this.pendingAuthPrompts.get(tab.id)?.abort();
        const controller = new AbortController();
        this.pendingAuthPrompts.set(tab.id, controller);
        this.selectTab(tab.id);
        void promptForHttpAuth(this.win, {
          origin: boundBrowserText(
            origin || `${authInfo.host}:${authInfo.port}`,
            512,
          ),
          realm,
        }, {
          signal: controller.signal,
          timeoutMs: DIALOG_TIMEOUT_MS,
        }).then((credentials) => {
          if (!credentials) callback();
          else {
            callback(
              boundBrowserText(credentials.username, 1_024),
              boundBrowserText(credentials.password, 8_192),
            );
          }
        }, () => callback()).finally(() => {
          if (this.pendingAuthPrompts.get(tab.id) === controller) {
            this.pendingAuthPrompts.delete(tab.id);
          }
        });
      },
      certificateError: (
        event,
        url,
        error,
        certificate,
        callback,
        isMainFrame,
      ) => {
        event.preventDefault();
        if (!isMainFrame) {
          callback(false);
          return;
        }
        let origin = url;
        try {
          origin = new URL(url).origin;
        } catch {
          // Retain the bounded URL.
        }
        const subject = certificate.subjectName
          || certificate.subject?.commonName
          || 'unknown certificate';
        this.promptManager.presentDialog(tab, {
          kind: 'certificate',
          message: `${boundBrowserText(error, 256)} (${boundBrowserText(subject, 256)}). Continue only if you trust this site.`,
          origin: boundBrowserText(origin, 512),
        }, (response) => callback(response.accept));
      },
      debuggerMessage: (method, params) => {
        if (
          method !== 'Page.javascriptDialogOpening'
          || !params
          || typeof params !== 'object'
        ) return;
        const details = params as {
          type?: unknown;
          message?: unknown;
          defaultPrompt?: unknown;
          url?: unknown;
        };
        const kind = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(
          String(details.type),
        )
          ? String(details.type) as 'alert' | 'confirm' | 'prompt' | 'beforeunload'
          : 'alert';
        this.promptManager.presentDialog(tab, {
          kind,
          message: boundBrowserText(details.message, 4_096),
          defaultValue: kind === 'prompt'
            ? boundBrowserText(details.defaultPrompt, 4_096)
            : undefined,
          origin: typeof details.url === 'string'
            ? boundBrowserText(details.url, 512)
            : undefined,
        }, (response) => {
          if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
          void contents.debugger.sendCommand(
            'Page.handleJavaScriptDialog',
            {
              accept: response.accept,
              ...(kind === 'prompt'
                ? { promptText: boundBrowserText(response.value, 4_096) }
                : {}),
            },
          ).catch((error) => {
            this.setStatus(
              tab,
              `Could not answer page dialog: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        });
      },
      initializeDebugger: (wiredContents) => {
        try {
          this.ensureDebugger(wiredContents);
        } catch (error) {
          // Browsing remains usable with native dialogs when CDP is unavailable.
          // Agent dialog control fails closed without weakening page isolation.
          this.setStatus(
            tab,
            `Dialog automation unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      openWindow: (details) => {
        if (
          !this.isSafeUrl(details.url)
          && details.url !== 'about:blank'
        ) return { action: 'deny' };
        try {
          const inheritedPolicy = this.agentNavigationPolicies.get(tab.id);
          const agentControlled = this.agentControlledTabs.has(tab.id);
          const child = this.createTab(
            details.url === 'about:blank' ? BROWSER_BLANK_URL : details.url,
            !agentControlled,
            {
              deferLoad: true,
              agentControlled,
              agentPolicy: inheritedPolicy ?? {},
            },
          );
          if (agentControlled) {
            this.downloadManager.transferAgentAllowance(tab.id, child.id);
          }
          const childContents = this.nativeViews.contents(child.id);
          if (!childContents) return { action: 'deny' };
          return { action: 'allow', createWindow: () => childContents };
        } catch {
          return { action: 'deny' };
        }
      },
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
    return recordUserPrivateOriginTrust(
      rawUrl,
      this.trustedUserPrivateOrigins,
      this.userOriginChecks,
      (url, policy) => this.destinationAllowed(url, policy),
    );
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
      case 'close-tab': return this.closeTab(command.tabId ?? tab?.id ?? this.tabState.activeTabId);
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
      case 'snapshot': return this.snapshot(this.requireTab(tab), command.mode, command.scope);
      case 'find-nodes': return this.findNodes(this.requireTab(tab), command.query, command.by, command.limit, command.scope);
      case 'design-audit': return this.designAudit(this.requireTab(tab), command.rules, command.maxFindings);
      case 'text': return this.pageText(this.requireTab(tab), command.maxChars);
      case 'html': return this.pageHtml(this.requireTab(tab), command.maxChars);
      case 'screenshot': return this.screenshot(this.requireTab(tab), command.maxDimension, command.fullPage);
      case 'console': {
        const current = this.requireTab(tab);
        const rows = this.nativeViews.consoleEntries(current.id);
        if (command.clear) this.nativeViews.clearConsole(current.id);
        return rows;
      }
      case 'network': {
        const current = this.requireTab(tab); const rows = await this.isolated<BrowserNetworkEntry[]>(current.id, performanceNetworkScript());
        assertCurrent();
        if (command.clear) await this.isolated(current.id, `(() => { try { performance.clearResourceTimings(); } catch {} return true; })()`);
        return boundBrowserArray(rows ?? [], MAX_NETWORK_ROWS);
      }
      case 'downloads': return this.downloadManager.list();
      case 'click': case 'double-click': case 'hover': case 'assert-visible': case 'highlight':
        return this.pointerCommand(this.requireTab(tab), command, assertCurrent);
      case 'type': return this.typeCommand(this.requireTab(tab), command, assertCurrent);
      case 'press': return this.pressCommand(this.requireTab(tab), command);
      case 'scroll': return this.scrollCommand(this.requireTab(tab), command);
      case 'drag': return this.dragCommand(this.requireTab(tab), command, assertCurrent);
      case 'select': return this.selectCommand(this.requireTab(tab), command, assertCurrent);
      case 'check': return this.checkCommand(this.requireTab(tab), command, assertCurrent);
      case 'set-files': return this.setFilesCommand(
        this.requireTab(tab),
        command,
        assertCurrent,
        operation.signal,
      );
      case 'set-cursor': return this.setCursor(this.requireTab(tab), command.enabled);
      case 'set-device': return this.setDevice(this.requireTab(tab), command.device, assertCurrent);
      case 'clear-highlight': return this.isolated(this.requireTab(tab).id, `(() => { document.getElementById('__brainrouter_testid_highlights__')?.remove(); const el=window.__brainrouterHighlighted; if(el){el.style.outline=window.__brainrouterPreviousOutline||'';el.style.outlineOffset='';} window.__brainrouterHighlighted=null; return {ok:true}; })()`);
      case 'respond-permission': return this.promptManager.respondPermission(command.promptId, command.allow);
      case 'respond-dialog': return this.promptManager.respondDialog(command);
      case 'open-download': case 'show-download': case 'cancel-download': case 'pause-download': case 'resume-download': return this.downloadManager.execute(command.op, command.downloadId);
      case 'add-bookmark': {
        const target = command.url ? command.url : this.requireTab(tab).url;
        const title = command.title ?? (command.url ? '' : this.requireTab(tab).title);
        this.bookmarks = addBrowserBookmark(this.bookmarks, { url: target, title, at: Date.now() });
        this.workspacePersistence.schedule();
        this.emitState();
        return { ok: true, bookmarks: this.bookmarks.length };
      }
      case 'remove-bookmark': {
        this.bookmarks = removeBrowserBookmark(this.bookmarks, command.url);
        this.workspacePersistence.schedule();
        this.emitState();
        return { ok: true, bookmarks: this.bookmarks.length };
      }
      case 'history': return this.historyView(command.query, command.limit);
      case 'omnibox-suggest':
        return omniboxSuggest(command.query, { bookmarks: this.bookmarks, history: this.history, limit: command.limit });
      case 'share-tab': return this.shareTab(command.tabId, true);
      case 'unshare-tab': return this.shareTab(command.tabId, false);
      case 'print': return this.printToPdf(this.requireTab(tab), command.landscape);
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
    this.tabState.select(id);
    this.attachActiveView();
    this.persistWorkspace();
    this.emitState();
    return { ...tab };
  }

  private closeTab(id: string): BrowserTab {
    const removed = this.tabState.remove(id);
    const { tab } = removed;
    this.destroyView(id);
    if (removed.needsBlankTab) {
      this.createTab(BROWSER_BLANK_URL, true);
    } else if (removed.activeChanged) {
      this.attachActiveView();
    }
    this.persistWorkspace();
    this.emitState();
    return { ...tab };
  }

  private reopenTab(): BrowserTab {
    const closed = this.tabState.takeClosed();
    return this.createTab(closed?.url ?? BROWSER_BLANK_URL, true, { title: closed?.title });
  }

  private reorderTab(id: string, toIndex: number): BrowserTab[] {
    const tabs = this.tabState.reorder(id, toIndex);
    this.persistWorkspace();
    this.emitState();
    return tabs;
  }

  private async snapshot(tab: BrowserTab, mode: 'semantic' | 'testids' | 'accessibility' = 'semantic', scope: 'viewport' | 'page' = 'viewport'): Promise<unknown> {
    tab.revision += 1;
    const snapshot = await this.isolated<{ url: string; title: string; scope?: string; nodes: BrowserSemanticNode[] }>(tab.id, semanticSnapshotScript(tab.id, tab.revision, scope));
    this.emitState();
    if (mode === 'testids') return { ...snapshot, nodes: snapshot.nodes.filter((node) => node.testid) };
    if (mode === 'accessibility') return { ...snapshot, nodes: snapshot.nodes.filter((node) => node.role) };
    return snapshot;
  }

  /** ADR-055 P4 — locate live-page nodes by role, visible text, label, or
   *  test-id and return their fresh revision-bound refs. A snapshot under the
   *  hood (scope 'page' by default) so a match scrolled out of view is still
   *  found; ambiguity surfaces as multiple candidates, never a silent guess. */
  private async findNodes(
    tab: BrowserTab,
    query: string,
    by: 'role' | 'text' | 'label' | 'testid' = 'text',
    limit = 20,
    scope: 'viewport' | 'page' = 'page',
  ): Promise<unknown> {
    tab.revision += 1;
    const snap = await this.isolated<{ url: string; title: string; nodes: BrowserSemanticNode[] }>(tab.id, semanticSnapshotScript(tab.id, tab.revision, scope));
    this.emitState();
    const q = String(query || '').trim().toLowerCase();
    const nodes = (snap.nodes ?? []).filter((node) => {
      const name = String(node.name || '').toLowerCase();
      const testid = String(node.testid || '').toLowerCase();
      const role = String(node.role || '').toLowerCase();
      if (by === 'testid') return testid === q || testid.includes(q);
      if (by === 'role') return role === q || (role.length > 0 && name.includes(q));
      // 'text' | 'label' — accessible name / label / test-id substring.
      return name.includes(q) || testid.includes(q);
    }).slice(0, Math.max(1, Math.min(Math.floor(limit) || 20, 100)));
    return { url: snap.url, title: snap.title, query, by, count: nodes.length, nodes };
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
    // ADR-055 P2 — a coordinate action: the model clicks where the screenshot
    // shows. Resolve the element under the point, refuse a credential field, and
    // report the hit element (a receipt) instead of a bare ok.
    if (command.x !== undefined && command.y !== undefined && !command.ref && !command.target
        && (command.op === 'click' || command.op === 'double-click' || command.op === 'hover')) {
      const x = Math.round(command.x), y = Math.round(command.y);
      const hit = await this.isolated<{ ok: boolean; sensitive?: boolean; element?: { role: string; name: string; tag: string; type?: string }; rect?: { x: number; y: number; width: number; height: number } }>(tab.id, pointHitScript(x, y));
      assertCurrent();
      if (!hit.ok) throw new BrowserManagerError('REF_NOT_FOUND', `No element was found at (${x}, ${y}).`);
      if (hit.sensitive) throw new BrowserManagerError('DENIED', 'Refused a coordinate action on a credential field. Use the field label instead.');
      this.showAgentPointer(tab.id, x, y, command.op !== 'hover');
      this.sendAgentInput(tab.id, { type: 'mouseMove', x, y });
      if (command.op === 'hover') return { ok: true, x, y, element: hit.element };
      const count = command.op === 'double-click' ? 2 : 1;
      const button = command.button ?? 'left';
      const modifiers = (command.modifiers ?? []).map((value) => value.toLowerCase() as 'alt' | 'control' | 'meta' | 'shift');
      this.sendAgentInput(tab.id, { type: 'mouseDown', x, y, button, clickCount: count, modifiers });
      this.sendAgentInput(tab.id, { type: 'mouseUp', x, y, button, clickCount: count, modifiers });
      tab.revision += 1; this.emitState(); return { ok: true, x, y, element: hit.element };
    }
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
    // ADR-055 P2 — drag between two screenshot-frame points.
    if (command.fromX !== undefined && command.fromY !== undefined && command.toX !== undefined && command.toY !== undefined
        && !command.fromRef && !command.toRef) {
      const sx = Math.round(command.fromX), sy = Math.round(command.fromY);
      const tx = Math.round(command.toX), ty = Math.round(command.toY);
      assertCurrent();
      this.showAgentPointer(tab.id, sx, sy, true);
      this.sendAgentInput(tab.id, { type: 'mouseMove', x: sx, y: sy }); this.sendAgentInput(tab.id, { type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 });
      this.showAgentPointer(tab.id, tx, ty, false);
      this.sendAgentInput(tab.id, { type: 'mouseMove', x: tx, y: ty, movementX: tx - sx, movementY: ty - sy }); this.sendAgentInput(tab.id, { type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });
      tab.revision += 1; this.emitState(); return { ok: true };
    }
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
    signal?: AbortSignal,
  ): Promise<{ accepted: true; fileCount: number }> {
    this.validateRef(tab, command.ref);
    if (!command.ref && !command.target) throw new BrowserManagerError('INVALID_REQUEST', 'A file input reference or test id is required.');
    let staged: Awaited<ReturnType<typeof stageWorkspaceUploadFiles>>;
    try {
      staged = await stageWorkspaceUploadFiles({
        workspaceRoot: this.workspaceRoot,
        tempRoot: app.getPath('temp'),
        files: command.files,
        signal,
      });
    } catch (error) {
      if (error instanceof UploadStagingError) {
        throw new BrowserManagerError(error.code, error.message);
      }
      throw error;
    }
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

  /** Reset the browser to a brand-new state: close every tab (which destroys the
   *  per-tab navigation history), wipe the partition's cookies/cache/storage, and
   *  open a single fresh blank tab. This is the user-facing "reset browser". */
  private async resetBrowser(): Promise<{ ok: true }> {
    for (const tab of [...this.tabState.all()]) {
      try { this.closeTab(tab.id); } catch { /* best effort */ }
    }
    await this.clearData(['cache', 'cookies', 'storage', 'history']);
    this.promptManager.clearPermissions();
    if (this.tabState.length === 0) this.createTab(BROWSER_BLANK_URL, true);
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
    // ADR-055 P9 — 'history' clears the workspace visit log too (bookmarks are
    // deliberate saves and survive; Reset browser only clears browsing traces).
    if (types.includes('history')) {
      this.history = [];
      this.lastHistoryUrl.clear();
      this.workspacePersistence.schedule();
      this.emitState();
    }
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
    this.downloadManager.releaseTab(tabId);
    this.syntheticInputUntil.delete(tabId);
  }

  private showContextMenu(tab: BrowserTab, params: ContextMenuParams): void {
    const contents = this.requireContents(tab.id);
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL && this.isSafeUrl(params.linkURL)) {
      template.push(
        { label: 'Open link in new tab', click: () => this.createTab(params.linkURL, true) },
        // ADR-055 P10 — ordinary context-menu parity.
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { label: 'Open link in default browser', click: () => { void shell.openExternal(params.linkURL); } },
        { type: 'separator' },
      );
    }
    if (params.srcURL && this.isSafeUrl(params.srcURL)) {
      template.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) }, { type: 'separator' });
    }
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
    if (mod && key === 'w') { event.preventDefault(); this.closeTab(this.tabState.activeTabId); return; }
    if (mod && key === 'l') { event.preventDefault(); this.win.webContents.focus(); this.emit({ type: 'focus-location', tabId: this.tabState.activeTabId }); return; }
    if (mod && key === 'f') { event.preventDefault(); this.win.webContents.focus(); this.emit({ type: 'focus-find', tabId: this.tabState.activeTabId }); return; }
    if (mod && key === 'r') { event.preventDefault(); this.requireContents(this.tabState.activeTabId).reload(); return; }
    // ADR-055 P9b — bookmark this page (the page has focus, so main owns ⌘D).
    if (mod && key === 'd') {
      event.preventDefault();
      const current = this.activeTab();
      this.bookmarks = addBrowserBookmark(this.bookmarks, { url: current.url, title: current.title, at: Date.now() });
      this.workspacePersistence.schedule();
      this.setStatus(current, 'Bookmarked.');
      this.emitState();
      return;
    }
    if (mod && /^[1-9]$/.test(key)) {
      event.preventDefault();
      const tabs = this.tabState.all();
      const index = key === '9' ? tabs.length - 1 : Number(key) - 1;
      if (tabs[index]) this.selectTab(tabs[index].id);
      return;
    }
    if (mod && ['+', '=', '-', '0'].includes(key)) {
      event.preventDefault(); const tab = this.activeTab(); const contents = this.requireContents(tab.id); const next = key === '0' ? 1 : contents.getZoomFactor() + (key === '-' ? -0.1 : 0.1); contents.setZoomFactor(Math.min(5, Math.max(0.25, next))); tab.zoomFactor = contents.getZoomFactor(); this.emitState(); return;
    }
    if (input.alt && key === 'left') { event.preventDefault(); const c = this.requireContents(this.tabState.activeTabId); if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); return; }
    if (input.alt && key === 'right') { event.preventDefault(); const c = this.requireContents(this.tabState.activeTabId); if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); }
  }

  private attachActiveView(): void {
    // ADR-055 P10 — a tab in HTML5 fullscreen fills the window, ignoring the
    // panel surface the renderer would otherwise dictate.
    const activeId = this.tabState.activeTabId;
    if (this.htmlFullscreenTabId === activeId && !this.win.isDestroyed()) {
      const bounds = this.win.getContentBounds();
      this.nativeViews.attach(activeId, { x: 0, y: 0, width: bounds.width, height: bounds.height, visible: true });
      return;
    }
    this.nativeViews.attach(activeId, this.surface);
  }

  private safeUrl(raw: string): string {
    // ADR-055 P9 — typed text becomes a search on the CONFIGURED engine.
    let searchEngine = '';
    try { searchEngine = getCliKnobs().browser.searchEngine; } catch { searchEngine = ''; }
    const normalized = raw === BROWSER_BLANK_URL ? raw : normalizeBrowserAddress(raw, searchEngine);
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
    const wanted = id || this.tabState.activeTabId;
    const tab = this.tabState.get(wanted);
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
    return this.nativeViews.requireContents(id);
  }

  private tabForContents(contentsId: number): BrowserTab | null {
    const tabId = this.nativeViews.tabIdForContents(contentsId);
    return tabId ? this.tabState.get(tabId) : null;
  }

  private validateRef(tab: BrowserTab, ref?: string): void {
    if (!ref) return;
    if (!isOpaqueBrowserRef(ref)) throw new BrowserManagerError('INVALID_REQUEST', 'Element reference is invalid.');
    const prefix = `br:${tab.id}:${tab.revision}:`;
    if (!ref.startsWith(prefix)) throw new BrowserManagerError('STALE_PAGE', 'Element reference belongs to a different tab or page revision. Take a new snapshot.');
  }

  /**
   * ADR-056 D-B1 — the browser design engine: the detector's rule ids over
   * COMPUTED styles in the live page (contrast against the composited
   * background, clipped or covered text, first-viewport horizontal overflow,
   * content hidden at rest, tiny text, small targets). Bounded, read-only,
   * runs in the isolated world like the snapshot; the core side folds the
   * answer into detector findings and honours the workspace suppressions.
   */
  private async designAudit(tab: BrowserTab, rules?: string[], maxFindings = 80): Promise<unknown> {
    return this.isolated(tab.id, designAuditScript(rules ?? [], Math.max(1, Math.min(200, maxFindings))));
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

  /**
   * ADR-055 P9 — record one visit per page load. Agent-controlled tabs are
   * excluded so research browsing never floods the person's history.
   */
  private noteVisit(tab: BrowserTab): void {
    const url = tab.url;
    if (!url || this.lastHistoryUrl.get(tab.id) === url) return;
    this.lastHistoryUrl.set(tab.id, url);
    this.history = recordBrowserVisit(this.history, { url, title: tab.title, at: Date.now() });
    this.workspacePersistence.schedule();
  }

  /** A title usually arrives after the navigation; refresh it without re-counting the visit. */
  private refreshVisitTitle(tab: BrowserTab): void {
    if (this.lastHistoryUrl.get(tab.id) !== tab.url) return;
    const persisted = persistableBrowserUrl(tab.url);
    let changed = false;
    this.history = this.history.map((entry) => {
      if (entry.url !== persisted || !tab.title || entry.title === tab.title) return entry;
      changed = true;
      return { ...entry, title: tab.title.slice(0, 300) };
    });
    if (changed) this.workspacePersistence.schedule();
  }

  /** ADR-055 P9 — the omnibox/history view, newest-first and bounded. */
  private historyView(query?: string, limit?: number): BrowserHistoryEntry[] {
    const cap = Math.max(1, Math.min(Math.floor(limit ?? 200), 1_000));
    const needle = String(query ?? '').trim().toLowerCase();
    const rows = needle
      ? this.history.filter((entry) => entry.url.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle))
      : this.history;
    return rows.slice(0, cap);
  }

  /**
   * ADR-055 P10 — Save as PDF. Writes into the workspace print folder and
   * returns the workspace-relative path, so the result is reachable by the
   * workspace file tools rather than a hidden temp file.
   */
  private async printToPdf(tab: BrowserTab, landscape?: boolean): Promise<{ ok: true; path: string }> {
    const data = await this.requireContents(tab.id).printToPDF({ landscape: landscape === true, printBackground: true });
    const directory = browserPrintDir(this.workspaceRoot);
    fs.mkdirSync(directory, { recursive: true });
    const absolute = availableDownloadPath(directory, `${safeName(tab.title || 'page', 'page')}.pdf`);
    fs.writeFileSync(absolute, data, { mode: 0o600 });
    const relative = workspaceRelativeDownloadPath(absolute, this.workspaceRoot);
    if (!relative) throw new BrowserManagerError('DENIED', 'The print destination escaped the workspace.');
    return { ok: true, path: relative };
  }

  /**
   * ADR-055 P7 — main wires this so a share/unshare reaches the agent-control
   * manager, which owns per-chat tab authority.
   */
  setTabShareHandler(handler: ((info: { workspaceRoot: string; sessionKey: string; tabId: BrowserTabId; share: boolean }) => void) | null): void {
    this.tabShareHandler = handler;
  }

  private notifyShare(tabId: BrowserTabId, share: boolean): void {
    this.tabShareHandler?.({
      workspaceRoot: this.workspaceRoot,
      sessionKey: this.sessionKey ?? '',
      tabId,
      share,
    });
  }

  private shareTab(tabId: BrowserTabId, share: boolean): { ok: true; shared: boolean } {
    const tab = this.resolveTab(tabId);
    if (!tab) throw new BrowserManagerError('TAB_NOT_FOUND', `Browser tab ${tabId} was not found.`);
    if (share) this.sharedTabs.add(tab.id);
    else this.sharedTabs.delete(tab.id);
    this.notifyShare(tab.id, share);
    this.emitState();
    return { ok: true, shared: share };
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

  private restoreWorkspace(): void {
    const persisted = this.workspaceStore.load();
    const rows = persisted?.version === 1 && Array.isArray(persisted.tabs) ? persisted.tabs.slice(0, MAX_BROWSER_TABS) : [];
    for (const row of rows) {
      const raw = typeof row.url === 'string' && !row.url.startsWith('data:') ? row.url : BROWSER_BLANK_URL;
      try { this.createTab(raw, false); } catch { /* skip unsafe/stale row */ }
    }
    const decisions = persisted?.version === 1 && Array.isArray(persisted.permissions)
      ? persisted.permissions.slice(0, 200)
      : [];
    this.promptManager.restorePermissions(decisions);
    this.bookmarks = persisted?.version === 1 && Array.isArray(persisted.bookmarks) ? persisted.bookmarks : [];
    this.history = persisted?.version === 1 && Array.isArray(persisted.history) ? persisted.history : [];
    const tabs = this.tabState.all();
    if (tabs.length > 0) {
      this.selectTab(
        tabs[
          Math.max(
            0,
            Math.min(tabs.length - 1, Math.floor(persisted?.activeIndex ?? 0)),
          )
        ].id,
      );
    }
  }

  private persistWorkspace(): void {
    this.workspacePersistence.flush();
  }

  private writeWorkspaceState(): void {
    if (this.disposed || !this.workspaceRoot) return;
    const state: PersistedBrowserWorkspace = {
      version: 1,
      activeIndex: Math.max(
        0,
        this.tabState.all().findIndex(
          (tab) => tab.id === this.tabState.activeTabId,
        ),
      ),
      tabs: this.tabState.all().map(
        (tab) => ({ url: persistableBrowserUrl(tab.url) }),
      ),
      permissions: this.promptManager.persistedPermissions(),
      bookmarks: this.bookmarks,
      history: this.history,
    };
    try {
      this.workspaceStore.save(state);
    } catch { /* best effort */ }
  }

  private destroyView(id: string): void {
    this.promptManager.cancelForTab(id);
    this.nativeViews.destroy(id, (contents) => {
      this.cleanupNativeViewOwnership(id, contents);
    });
  }

  private destroyAllViews(): void {
    this.nativeViews.destroyAll((id, contents) => {
      this.promptManager.cancelForTab(id);
      this.cleanupNativeViewOwnership(id, contents);
    });
  }

  private cleanupNativeViewOwnership(id: BrowserTabId, contents: WebContents): void {
    this.humanChallengeTabs.delete(id);
    if (this.sharedTabs.delete(id)) this.notifyShare(id, false);
    managersByWebContents.delete(contents.id);
    this.releaseAgentControl(id);
    this.cleanupStagedUpload(id);
    this.pendingAuthPrompts.get(id)?.abort();
    this.pendingAuthPrompts.delete(id);
    this.emulatedTabs.delete(id);
    this.queues.delete(id);
  }
}
