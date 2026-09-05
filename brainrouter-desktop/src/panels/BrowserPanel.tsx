/**
 * Browser-grade chrome for the main-process BrowserTabManager. Page contents are
 * native WebContentsViews: React owns only chrome/tooling and reports the exact
 * surface rectangle. The user and agent therefore operate the same live tab.
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { UiMap } from '@kinqs/brainrouter-core/browser';
import type {
  BrowserCommand,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserSemanticNode,
  BrowserState,
  BrowserTab,
} from '../../electron/browser/protocol.js';
import { Icon } from '../icons.js';
import {
  browserShortcut,
  browserTabTitle,
  browserViewRect,
  browserZoomLabel,
  BROWSER_BLANK_URL,
  nextBrowserOpenGeneration,
  normalizeBrowserInput, cycledTabIndex, shortcutTargetIsEditable } from '../lib/browser/browserPanelModel.js';
import { rowSource, symbolKindIcon } from '../lib/browser/rowSource.js';

type Drawer = 'elements' | 'console' | 'network' | 'a11y' | 'shot' | 'downloads' | 'flows' | 'bookmarks' | 'history' | null;

type OmniboxSuggestion = { url: string; title: string; source: 'bookmark' | 'history' };

/** Display-only origin for the site-info popover; falls back to the raw value. */
function originOf(raw: string): string {
  try { return new URL(raw).origin; } catch { return raw; }
}
type HistoryRow = { url: string; title: string; visitedAt: number; visits: number };
type Device = 'desktop' | 'tablet' | 'phone';
type ElementAction = 'tap' | 'type' | 'assertVisible' | 'navigate';
type LiveElement = BrowserSemanticNode & { target: string; action: ElementAction; label: string };
type FlowStep = { action: ElementAction; target: string; text?: string };
type StoryStep = { action: ElementAction; target: string; text?: string; label?: string; type?: string; route?: string | null };
type StoryPayload = { id?: string; title?: string; steps?: StoryStep[] };
type FindResult = { requestId?: number; activeMatchOrdinal?: number; matches?: number };

const DEVICE_W: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };
const DEVICE_H: Record<Device, number | null> = { desktop: null, tablet: 1_180, phone: 844 };
const FLOWS_KEY = 'br-browser-flows';
const URL_KEY = 'br-browser-url';
const UIMAP_KEY = 'br-browser-uimap';
const CURSOR_KEY = 'br-browser-cursor';

function readUiMap(): UiMap | null {
  try { const raw = localStorage.getItem(UIMAP_KEY); return raw ? (JSON.parse(raw) as UiMap) : null; } catch { return null; }
}

function loadFlows(): Record<string, FlowStep[]> {
  try { return JSON.parse(localStorage.getItem(FLOWS_KEY) || '{}') as Record<string, FlowStep[]>; } catch { return {}; }
}

function saveFlows(flows: Record<string, FlowStep[]>): void {
  try { localStorage.setItem(FLOWS_KEY, JSON.stringify(flows)); } catch { /* storage may be disabled */ }
}

function rowsFromValue<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as T[];
  return [];
}

function screenshotFromValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return typeof record.dataUrl === 'string' ? record.dataUrl : typeof record.image === 'string' ? record.image : '';
}

function elementAction(node: BrowserSemanticNode): ElementAction {
  const role = node.role.toLowerCase();
  const tag = node.tag.toLowerCase();
  const type = (node.type ?? '').toLowerCase();
  if (role === 'textbox' || role === 'searchbox' || tag === 'textarea' || tag === 'input' || type === 'text') return 'type';
  if (role === 'link' || tag === 'a') return 'navigate';
  if (role === 'button' || role === 'menuitem' || role === 'tab' || tag === 'button') return 'tap';
  return 'assertVisible';
}

function asLiveElements(nodes: BrowserSemanticNode[]): LiveElement[] {
  return nodes.map((node) => ({
    ...node,
    target: node.testid || node.ref,
    action: elementAction(node),
    label: node.name || node.testid || node.role || node.tag,
  }));
}

export function BrowserPanel({ panelVisible = true }: { panelVisible?: boolean }): React.ReactElement {
  const browser = window.brainrouter.browser;
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [bridgeError, setBridgeError] = useState(browser ? '' : 'Native browser unavailable. Restart BrainRouter after updating the desktop app.');
  const [openGeneration, setOpenGeneration] = useState<number | undefined>();
  const [urlDraft, setUrlDraft] = useState(() => localStorage.getItem(URL_KEY) || 'http://localhost:5173');
  const [device, setDevice] = useState<Device>('desktop');
  // User-adjustable layout: a custom viewport width (px) overrides the device
  // preset (drag the right edge), and a custom drawer height (px). Both null =
  // use the defaults. The native view is repositioned by the ResizeObserver.
  const [customW, setCustomW] = useState<number | null>(null);
  const [drawerH, setDrawerH] = useState<number>(240);
  const [drawer, setDrawer] = useState<Drawer>(null);
  // ADR-055 P9b/P10b — omnibox autocomplete, history rows, and the site-info popover.
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([]);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [elements, setElements] = useState<LiveElement[]>([]);
  const [consoleMsgs, setConsoleMsgs] = useState<BrowserConsoleEntry[]>([]);
  const [network, setNetwork] = useState<BrowserNetworkEntry[]>([]);
  const [a11y, setA11y] = useState<BrowserSemanticNode[]>([]);
  const [shot, setShot] = useState('');
  const [highlightOn, setHighlightOn] = useState(false);
  const [cursorOn, setCursorOn] = useState(() => localStorage.getItem(CURSOR_KEY) !== '0');
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState('');
  const [typeVal, setTypeVal] = useState('test');
  const [status, setStatus] = useState('');
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<FlowStep[]>([]);
  const [flows, setFlows] = useState<Record<string, FlowStep[]>>(() => loadFlows());
  const [flowName, setFlowName] = useState('');
  const [drive, setDrive] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [uiMap, setUiMap] = useState<UiMap | null>(() => readUiMap());
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<FindResult>({});
  const [dialogValue, setDialogValue] = useState('');
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [pausedDownloads, setPausedDownloads] = useState<Set<string>>(() => new Set());

  const hostRef = useRef<HTMLDivElement>(null);
  // While a resize handle is being dragged, the native page view is hidden so it
  // stops swallowing the pointer events the drag needs (a native WebContentsView
  // sits above the renderer and captures the cursor over its bounds).
  const resizingRef = useRef(false);
  const omniboxRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingStateRef = useRef<BrowserState | null>(null);
  const stateFrameRef = useRef<number | null>(null);

  const activeTab = useMemo<BrowserTab | null>(() => {
    if (!browserState) return null;
    return browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? browserState.tabs[0] ?? null;
  }, [browserState]);
  const activeUrl = activeTab?.url ?? urlDraft;
  const ready = !!activeTab && !activeTab.loading && !activeTab.crashed;

  const applyStateBatched = useCallback((state: BrowserState): void => {
    pendingStateRef.current = state;
    if (stateFrameRef.current != null) return;
    stateFrameRef.current = requestAnimationFrame(() => {
      stateFrameRef.current = null;
      const pending = pendingStateRef.current;
      pendingStateRef.current = null;
      if (pending) setBrowserState(pending);
    });
  }, []);

  const refreshState = useCallback(async (): Promise<void> => {
    if (!browser) return;
    try {
      applyStateBatched(await browser.getState());
      setBridgeError('');
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : String(error));
    }
  }, [applyStateBatched, browser]);

  const runBrowser = useCallback(async <T,>(command: BrowserCommand): Promise<T> => {
    if (!browser) throw new Error('Native browser bridge is unavailable');
    const result = await browser.command<T>(command);
    if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
    return result.value;
  }, [browser]);

  const mutateBrowser = useCallback(async (command: BrowserCommand): Promise<void> => {
    await runBrowser(command);
    await refreshState();
  }, [refreshState, runBrowser]);

  const fireBrowser = useCallback((command: BrowserCommand, after?: () => void): void => {
    void mutateBrowser(command).then(after).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [mutateBrowser]);

  // ── ADR-055 P9b — bookmarks, history, omnibox autocomplete ────────────────
  const bookmarks = browserState?.bookmarks ?? [];
  const activeBookmarked = !!activeTab && bookmarks.some((entry) => entry.url === activeTab.url
    || entry.url === activeTab.url.replace(/[?#].*$/, ''));

  const toggleBookmark = useCallback((): void => {
    if (!activeTab) return;
    fireBrowser(activeBookmarked
      ? { op: 'remove-bookmark', url: activeTab.url }
      : { op: 'add-bookmark' });
  }, [activeBookmarked, activeTab, fireBrowser]);

  const loadHistory = useCallback(async (): Promise<void> => {
    try { setHistoryRows(await runBrowser<HistoryRow[]>({ op: 'history', limit: 200 })); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [runBrowser]);

  // Local-only autocomplete: bookmarks + history, never a remote suggest service.
  useEffect(() => {
    const query = urlDraft.trim();
    if (!suggestOpen || !query) { setSuggestions([]); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      void runBrowser<OmniboxSuggestion[]>({ op: 'omnibox-suggest', query, limit: 8 })
        .then((rows) => { if (!cancelled) { setSuggestions(rows ?? []); setSuggestIndex(-1); } })
        .catch(() => { if (!cancelled) setSuggestions([]); });
    }, 90);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [urlDraft, suggestOpen, runBrowser]);


  // Subscribe once. State events are animation-frame batched so rapid title,
  // loading and favicon events never rerender the complete panel individually.
  useEffect(() => {
    if (!browser) return;
    void refreshState();
    const off = browser.onEvent((event) => {
      if (event.type === 'state') applyStateBatched(event.state);
      else if (event.type === 'focus-location') requestAnimationFrame(() => { omniboxRef.current?.focus(); omniboxRef.current?.select(); });
      else if (event.type === 'focus-find') { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()); }
      else if (event.type === 'status') setStatus(event.text);
      else if (event.type === 'download') {
        setBrowserState((state) => state ? { ...state, downloads: [...state.downloads.filter((row) => row.id !== event.download.id), event.download] } : state);
      } else if (event.type === 'permission') {
        setBrowserState((state) => state ? { ...state, permissionPrompt: event.prompt } : state);
      } else if (event.type === 'dialog') {
        setBrowserState((state) => state ? { ...state, dialogPrompt: event.prompt } : state);
      }
    });
    return () => {
      off();
      if (stateFrameRef.current != null) cancelAnimationFrame(stateFrameRef.current);
      stateFrameRef.current = null;
      pendingStateRef.current = null;
    };
  }, [applyStateBatched, browser, refreshState]);

  useEffect(() => {
    if (!activeTab) return;
    setUrlDraft(activeTab.url === BROWSER_BLANK_URL || activeTab.url.startsWith('data:text/html') ? '' : activeTab.url);
    if (activeTab.url && !activeTab.url.startsWith('data:text/html')) {
      try { localStorage.setItem(URL_KEY, activeTab.url); } catch { /* ignore */ }
    }
  }, [activeTab?.id, activeTab?.url]);

  // Native views live above renderer pixels. Report only the true content host
  // rectangle, and hide on unmount, occlusion, document hide, or a crashed tab.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!browser || !host) return;
    let intersecting = true;
    let frame: number | null = null;
    let last = '';
    const report = (): void => {
      frame = null;
      // ⌘+/⌘- zoom scales the renderer via webFrame.setZoomFactor, but the native
      // page view is positioned in un-zoomed WINDOW pixels — so a DOM rect in the
      // zoomed frame must be multiplied by the zoom factor or the view overflows
      // its box (bleeding over the drawer / neighbouring panels) at any zoom ≠ 1.
      const zoom = window.brainrouter?.getZoomFactor?.() || 1;
      const raw = host.getBoundingClientRect();
      const rect = browserViewRect({ left: raw.left * zoom, top: raw.top * zoom, width: raw.width * zoom, height: raw.height * zoom });
      const surface = {
        ...rect,
        visible: panelVisible && intersecting && document.visibilityState === 'visible' && !bridgeError && !activeTab?.crashed && !resizingRef.current && rect.width > 1 && rect.height > 1,
      };
      const serialized = JSON.stringify(surface);
      if (serialized !== last || openGeneration !== undefined) {
        last = serialized;
        browser.setSurface(surface, openGeneration);
      }
    };
    const schedule = (): void => {
      if (frame == null) frame = requestAnimationFrame(report);
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(host);
    const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      intersecting = entries[0]?.isIntersecting !== false;
      schedule();
    });
    intersection?.observe(host);
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      resize?.disconnect();
      intersection?.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      if (frame != null) cancelAnimationFrame(frame);
      const rect = browserViewRect(host.getBoundingClientRect());
      browser.setSurface({ ...rect, visible: false });
    };
  }, [activeTab?.crashed, bridgeError, browser, openGeneration, panelVisible]);

  useEffect(() => {
    const onOpenGeneration = (event: Event): void => {
      const generation = (event as CustomEvent<{ generation?: unknown }>).detail?.generation;
      setOpenGeneration((current) => nextBrowserOpenGeneration(current, generation));
    };
    window.addEventListener('br-browser-open-generation', onOpenGeneration);
    return () => window.removeEventListener('br-browser-open-generation', onOpenGeneration);
  }, []);

  const go = useCallback(async (next: string): Promise<void> => {
    const url = normalizeBrowserInput(next);
    if (!url) { setStatus('Enter a URL or search term.'); return; }
    try {
      setStatus('');
      setUrlDraft(url);
      await mutateBrowser({ op: 'navigate', url });
      if (recording) setRecorded((steps) => [...steps, { action: 'navigate', target: url }]);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [mutateBrowser, recording]);

  const closeFind = useCallback((): void => {
    setFindOpen(false);
    setFindResult({});
    void runBrowser({ op: 'stop-find', action: 'clearSelection' }).catch(() => undefined);
  }, [runBrowser]);

  const runFind = useCallback((forward: boolean, findNext = true): void => {
    if (!findText) return;
    void runBrowser<FindResult>({ op: 'find', text: findText, forward, findNext })
      .then(setFindResult)
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [findText, runBrowser]);

  const changeZoom = useCallback(async (delta: number | 'reset'): Promise<void> => {
    const factor = delta === 'reset' ? 1 : Math.min(5, Math.max(0.25, (activeTab?.zoomFactor ?? 1) + delta));
    try { await mutateBrowser({ op: 'set-zoom', factor: Math.round(factor * 10) / 10 }); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [activeTab?.zoomFactor, mutateBrowser]);

  // Choosing a device preset clears any dragged custom width.
  const changeDevice = useCallback((next: Device): void => { setDevice(next); setCustomW(null); }, []);

  // Drag the right edge of the emulated viewport to resize its WIDTH freely
  // (Chrome responsive-mode style); double-click the handle to snap back to the
  // device preset / full width. Window-level listeners so the drag survives the
  // pointer leaving the thin handle.
  const onWidthResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const stageRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!stageRect) return;
    resizingRef.current = true;
    window.dispatchEvent(new Event('resize')); // hide the native view for the drag
    const onMove = (moveEvent: PointerEvent): void => {
      setCustomW(Math.max(320, Math.min(Math.round(stageRect.width), Math.round(moveEvent.clientX - stageRect.left))));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      resizingRef.current = false;
      window.dispatchEvent(new Event('resize')); // re-show the native view at the new bounds
    };
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // Drag the top edge of the drawer to resize its HEIGHT.
  const onDrawerResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const stageRect = event.currentTarget.closest('.browser-stage')?.getBoundingClientRect();
    if (!stageRect) return;
    resizingRef.current = true;
    window.dispatchEvent(new Event('resize')); // hide the native view for the drag
    const onMove = (moveEvent: PointerEvent): void => {
      setDrawerH(Math.max(90, Math.min(Math.round(stageRect.height - 120), Math.round(stageRect.bottom - moveEvent.clientY))));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      resizingRef.current = false;
      window.dispatchEvent(new Event('resize')); // re-show the native view at the new bounds
    };
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // Device emulation belongs to the selected native tab. Reapply it when tabs
  // change so the visual viewport and the page's CSS/touch metrics stay aligned.
  useEffect(() => {
    if (!activeTab) return;
    const frame = requestAnimationFrame(() => {
      const rect = hostRef.current?.getBoundingClientRect();
      const width = customW ?? DEVICE_W[device] ?? Math.max(240, Math.round(rect?.width ?? 1_440));
      const height = DEVICE_H[device] ?? Math.max(240, Math.round(rect?.height ?? 900));
      fireBrowser({ op: 'set-device', device: { name: device, width, height, deviceScaleFactor: device === 'desktop' ? 1 : 2, isMobile: device !== 'desktop' } });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab?.id, device, customW, fireBrowser]);

  // The native page view is a separate OS layer that does NOT reflow with the
  // DOM. The surface reporter (below) only re-runs on a ResizeObserver tick, so
  // a layout change that opens/closes/resizes the drawer or narrows the viewport
  // must proactively re-place the view — otherwise a stale bound lets the page
  // bleed over the drawer and adjacent panels. Fire after layout settles.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(id);
  }, [drawer, drawerH, device, customW]);

  const selectTabAt = useCallback((index: number, focusTab = true): void => {
    const tabs = browserState?.tabs ?? [];
    const tab = tabs[index];
    if (tab) void mutateBrowser({ op: 'select-tab', tabId: tab.id })
      .then(() => { if (focusTab) requestAnimationFrame(() => tabButtonRefs.current.get(tab.id)?.focus()); })
      .catch((error) => setStatus(String(error)));
  }, [browserState?.tabs, mutateBrowser]);

  const selectShortcutTab = useCallback((index: number): void => {
    const tabCount = browserState?.tabs.length ?? 0;
    selectTabAt(index === 8 ? tabCount - 1 : index, false);
  }, [browserState?.tabs.length, selectTabAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && findOpen) { event.preventDefault(); closeFind(); return; }
      const shortcut = browserShortcut(event);
      if (!shortcut) return;
      // ADR-055 P10b — Esc belongs to an editable target (the omnibox, a form field) before it means "stop the page".
      if (shortcut.command === 'stop' && shortcutTargetIsEditable(event.target)) return;
      event.preventDefault();
      if (shortcut.command === 'cycle-tab') {
        const list = browserState?.tabs ?? [];
        const next = cycledTabIndex(list.findIndex((tab) => tab.id === browserState?.activeTabId), list.length, shortcut.delta);
        if (next >= 0) selectTabAt(next, false);
        return;
      }
      if (shortcut.command === 'downloads') { setDrawer((current) => (current === 'downloads' ? null : 'downloads')); return; }
      if (shortcut.command === 'focus-omnibox') { omniboxRef.current?.focus(); omniboxRef.current?.select(); }
      else if (shortcut.command === 'find') { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()); }
      else if (shortcut.command === 'new-tab') void mutateBrowser({ op: 'create-tab', active: true }).then(() => requestAnimationFrame(() => omniboxRef.current?.focus())).catch((error) => setStatus(String(error)));
      else if (shortcut.command === 'close-tab') void mutateBrowser({ op: 'close-tab' }).catch((error) => setStatus(String(error)));
      else if (shortcut.command === 'reopen-tab') void mutateBrowser({ op: 'reopen-tab' }).catch((error) => setStatus(String(error)));
      else if (shortcut.command === 'select-tab') selectShortcutTab(shortcut.index);
      else if (shortcut.command === 'reload') void mutateBrowser({ op: 'reload', bypassCache: shortcut.bypassCache }).catch((error) => setStatus(String(error)));
      else if (shortcut.command === 'zoom-in') void changeZoom(0.1);
      else if (shortcut.command === 'zoom-out') void changeZoom(-0.1);
      else if (shortcut.command === 'zoom-reset') void changeZoom('reset');
      else void mutateBrowser({ op: shortcut.command }).catch((error) => setStatus(String(error)));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [browserState?.tabs, browserState?.activeTabId, changeZoom, closeFind, findOpen, mutateBrowser, selectShortcutTab, selectTabAt]);

  useEffect(() => {
    if (!findOpen || !findText) return;
    const timer = window.setTimeout(() => {
      void runBrowser<FindResult>({ op: 'find', text: findText }).then(setFindResult).catch((error) => setStatus(String(error)));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [findOpen, findText, runBrowser]);

  useEffect(() => {
    try { localStorage.setItem(CURSOR_KEY, cursorOn ? '1' : '0'); } catch { /* ignore */ }
    if (activeTab) void runBrowser({ op: 'set-cursor', enabled: cursorOn }).catch(() => undefined);
  }, [activeTab?.id, activeTab?.revision, cursorOn, runBrowser]);

  useEffect(() => {
    const prompt = browserState?.dialogPrompt;
    setDialogValue(prompt?.kind === 'prompt' ? prompt.defaultValue ?? '' : '');
  }, [browserState?.dialogPrompt?.id]);

  useEffect(() => {
    const onMap = (): void => setUiMap(readUiMap());
    window.addEventListener('br-browser-uimap', onMap);
    return () => window.removeEventListener('br-browser-uimap', onMap);
  }, []);

  useEffect(() => {
    const message = status.trim();
    if (message) setLogs((rows) => [...rows, `${new Date().toLocaleTimeString([], { hour12: false })}  ${message}`].slice(-300));
  }, [status]);

  useEffect(() => {
    const onLog = (event: Event): void => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message?.trim();
      if (message) setLogs((rows) => [...rows, `${new Date().toLocaleTimeString([], { hour12: false })}  ${message}`].slice(-300));
    };
    window.addEventListener('br-browser-log', onLog);
    return () => window.removeEventListener('br-browser-log', onLog);
  }, []);

  const withPage = async (action: () => Promise<void>): Promise<void> => {
    if (!activeTab || activeTab.loading || activeTab.crashed) { setStatus(activeTab?.crashed ? 'This tab crashed. Reload it to continue.' : 'Page is not ready yet.'); return; }
    try { await action(); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const doExtract = (): Promise<void> => withPage(async () => {
    const value = await runBrowser({ op: 'snapshot', mode: 'testids' });
    setElements(asLiveElements(rowsFromValue<BrowserSemanticNode>(value, ['nodes', 'elements'])));
    setDrawer('elements');
    setStatus('');
  });

  const startInspect = (): void => {
    setPickMode(true);
    void doExtract().then(() => setStatus('Choose an element in the snapshot to inspect it.'));
  };

  const toggleHighlight = (): Promise<void> => withPage(async () => {
    const next = !highlightOn;
    await runBrowser(next ? { op: 'highlight' } : { op: 'clear-highlight' });
    setHighlightOn(next);
  });

  const doScreenshot = (): Promise<void> => withPage(async () => {
    const value = await runBrowser({ op: 'screenshot', maxDimension: 2_560 });
    const dataUrl = screenshotFromValue(value);
    if (!dataUrl) throw new Error('Screenshot returned no image');
    setShot(dataUrl);
    setDrawer('shot');
  });

  const doConsole = (): Promise<void> => withPage(async () => {
    const value = await runBrowser({ op: 'console' });
    setConsoleMsgs(rowsFromValue<BrowserConsoleEntry>(value, ['entries', 'console']));
    setDrawer('console');
  });

  const doNetwork = (): Promise<void> => withPage(async () => {
    const value = await runBrowser({ op: 'network' });
    setNetwork(rowsFromValue<BrowserNetworkEntry>(value, ['entries', 'network']));
    setDrawer('network');
  });

  const doA11y = (): Promise<void> => withPage(async () => {
    const value = await runBrowser({ op: 'snapshot', mode: 'accessibility' });
    setA11y(rowsFromValue<BrowserSemanticNode>(value, ['nodes', 'elements']));
    setDrawer('a11y');
    if (!uiMap) window.dispatchEvent(new CustomEvent('br-browser-loaduimap'));
  });

  const hoverHighlight = (node: BrowserSemanticNode): void => {
    if (!ready) return;
    void runBrowser({ op: 'highlight', ref: node.ref }).catch(() => undefined);
  };
  const hoverClear = (): void => { if (ready && !highlightOn) void runBrowser({ op: 'clear-highlight' }).catch(() => undefined); };

  const shotName = (): string => {
    try { const parsed = new URL(activeUrl); return (parsed.hash || parsed.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'screen'; }
    catch { return 'screen'; }
  };

  const saveShot = (): void => {
    if (!shot) { setStatus('Take a screenshot first.'); return; }
    window.dispatchEvent(new CustomEvent('br-browser-savescreenshot', { detail: { dataUrl: shot, name: shotName() } }));
    setStatus('Saving screenshot…');
  };

  useEffect(() => {
    const onFocus = (): void => {
      try {
        const raw = localStorage.getItem('br-browser-focus');
        const target = raw ? (JSON.parse(raw) as { testID?: string }).testID || '' : '';
        if (!target) return;
        setDrive(target);
        setDrawer('elements');
        setStatus(`Driving "${target}" — extract, then run it.`);
      } catch { /* ignore */ }
    };
    window.addEventListener('br-browser-focus', onFocus);
    return () => window.removeEventListener('br-browser-focus', onFocus);
  }, []);

  useEffect(() => {
    const onNavigate = (event: Event): void => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (url) void go(url);
    };
    window.addEventListener('br-browser-navigate', onNavigate);
    return () => window.removeEventListener('br-browser-navigate', onNavigate);
  }, [go]);

  useEffect(() => { if (drive && ready) void doExtract(); }, [drive, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const record = (step: FlowStep): void => { if (recording) setRecorded((steps) => [...steps, step]); };

  const runElement = (element: LiveElement): Promise<void> => withPage(async () => {
    if (element.action === 'type') {
      await runBrowser({ op: 'type', ref: element.ref, target: element.testid, text: typeVal, replace: true });
      record({ action: 'type', target: element.target, text: typeVal });
    } else if (element.action === 'assertVisible') {
      await runBrowser({ op: 'assert-visible', ref: element.ref, target: element.testid });
      record({ action: 'assertVisible', target: element.target });
    } else {
      await runBrowser({ op: 'click', ref: element.ref, target: element.testid });
      record({ action: 'tap', target: element.target });
    }
    setStatus(`OK ${element.action} ${element.target}`);
  });

  const runStep = async (step: FlowStep, hint?: { label?: string; type?: string }): Promise<void> => {
    if (step.action === 'navigate') { const url = normalizeBrowserInput(step.target); if (url) await runBrowser({ op: 'navigate', url }); return; }
    if (step.action === 'type') await runBrowser({ op: 'type', target: step.target, text: step.text ?? '', replace: true });
    else if (step.action === 'assertVisible') await runBrowser({ op: 'assert-visible', target: step.target, label: hint?.label, targetType: hint?.type });
    else await runBrowser({ op: 'click', target: step.target, label: hint?.label, targetType: hint?.type });
  };

  const runFlow = (name: string): Promise<void> => withPage(async () => {
    for (const step of flows[name] || []) {
      try {
        await runStep(step);
        setStatus(`flow ${name}: ${step.action} ${step.target} → ok`);
      } catch (error) { setStatus(`flow ${name}: ${step.action} ${step.target} → ${String(error)}`); break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await refreshState();
  });

  const saveFlow = (): void => {
    const name = (flowName || 'flow').replace(/[^a-z0-9_-]+/gi, '-');
    const next = { ...flows, [name]: recorded };
    setFlows(next);
    saveFlows(next);
    setRecorded([]);
    setRecording(false);
    setFlowName('');
    setDrawer('flows');
  };

  const runStory = async (baseUrl: string, title: string, steps: StoryStep[], storyId?: string): Promise<void> => {
    if (!activeTab) return;
    setDrawer('elements');
    setStatus(`Running "${title}"…`);
    if (baseUrl) await go(baseUrl);
    const results: Array<{ i: number; action: string; target: string; ok: boolean; error?: string; ms?: number }> = [];
    const screenshots: Array<{ name: string; dataUrl: string }> = [];
    const grab = async (name: string): Promise<void> => {
      try { const image = screenshotFromValue(await runBrowser({ op: 'screenshot', maxDimension: 2_560 })); if (image) screenshots.push({ name, dataUrl: image }); } catch { /* preserve primary result */ }
    };
    let failed = false;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const target = step.action === 'navigate' && step.route
        ? new URL(step.route.startsWith('#') ? step.route : `#${step.route}`, activeUrl).href
        : step.target;
      const startedAt = Date.now();
      try {
        await runStep({ action: step.action, target, text: step.text }, { label: step.label, type: step.type });
        results.push({ i: index + 1, action: step.action, target: step.target, ok: true, ms: Date.now() - startedAt });
        setStatus(`[${index + 1}/${steps.length}] ${step.action} ${step.target} → ok`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ i: index + 1, action: step.action, target: step.target, ok: false, error: message, ms: Date.now() - startedAt });
        await grab(`step-${index + 1}-fail`);
        setStatus(`Story "${title}" stopped at step ${index + 1} — ${message}`);
        failed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (!failed) { await grab('final'); setStatus(`✓ Story "${title}" finished — ${steps.length} steps`); }
    const id = storyId || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
    window.dispatchEvent(new CustomEvent('br-browser-runresult', { detail: { story: { id, title }, baseUrl, results, screenshots } }));
    await refreshState();
  };

  useEffect(() => {
    const onRunStory = (event: Event): void => {
      const baseUrl = (event as CustomEvent<{ url?: string }>).detail?.url;
      let payload: StoryPayload | null = null;
      try { payload = JSON.parse(localStorage.getItem('br-browser-runstory') || 'null') as StoryPayload | null; } catch { payload = null; }
      if (payload?.steps?.length) void runStory(baseUrl || activeUrl, payload.title || 'story', payload.steps, payload.id);
    };
    window.addEventListener('br-browser-runstory', onRunStory);
    return () => window.removeEventListener('br-browser-runstory', onRunStory);
  }, [activeUrl, runBrowser]); // eslint-disable-line react-hooks/exhaustive-deps

  const respondPermission = async (allow: boolean): Promise<void> => {
    const prompt = browserState?.permissionPrompt;
    if (!prompt) return;
    try { await mutateBrowser({ op: 'respond-permission', promptId: prompt.id, allow }); }
    catch (error) { setStatus(String(error)); }
  };

  const respondDialog = async (accept: boolean): Promise<void> => {
    const prompt = browserState?.dialogPrompt;
    if (!prompt) return;
    try {
      await mutateBrowser({
        op: 'respond-dialog',
        promptId: prompt.id,
        accept,
        value: prompt.kind === 'prompt' ? dialogValue : undefined,
      });
    }
    catch (error) { setStatus(String(error)); }
  };

  const toggleTabMuted = async (tab: BrowserTab): Promise<void> => {
    try {
      if (tab.id !== activeTab?.id) await mutateBrowser({ op: 'select-tab', tabId: tab.id });
      await mutateBrowser({ op: 'set-muted', muted: !tab.muted });
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const toggleDownloadPaused = async (downloadId: string, paused: boolean): Promise<void> => {
    try {
      await mutateBrowser({ op: paused ? 'resume-download' : 'pause-download', downloadId });
      setPausedDownloads((current) => {
        const next = new Set(current);
        if (paused) next.delete(downloadId); else next.add(downloadId);
        return next;
      });
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const tabKeyDown = (event: React.KeyboardEvent, index: number, tab: BrowserTab): void => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fireBrowser({ op: 'select-tab', tabId: tab.id }); }
    else if (event.key === 'Delete') { event.preventDefault(); fireBrowser({ op: 'close-tab', tabId: tab.id }); }
    else if (event.altKey && event.shiftKey && event.key === 'ArrowLeft') { event.preventDefault(); fireBrowser({ op: 'reorder-tab', tabId: tab.id, toIndex: Math.max(0, index - 1) }); }
    else if (event.altKey && event.shiftKey && event.key === 'ArrowRight') { event.preventDefault(); fireBrowser({ op: 'reorder-tab', tabId: tab.id, toIndex: Math.min((browserState?.tabs.length ?? 1) - 1, index + 1) }); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); selectTabAt(Math.max(0, index - 1)); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); selectTabAt(Math.min((browserState?.tabs.length ?? 1) - 1, index + 1)); }
  };

  const railBtn = (icon: string, title: string, on: boolean, onClick: () => void, disabled = false): React.ReactElement => (
    <button className={`br-tool${on ? ' on' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={16} />
    </button>
  );

  // Custom drag width overrides the device preset; null on desktop = full width.
  const effectiveW = customW ?? DEVICE_W[device];
  const tabs = browserState?.tabs ?? [];
  // ADR-055 P10b — HTML5 fullscreen: the page owns the whole panel.
  const htmlFullscreen = !!browserState?.fullscreenTabId && browserState.fullscreenTabId === activeTab?.id;
  const permission = browserState?.permissionPrompt;
  const dialog = browserState?.dialogPrompt;
  const downloads = browserState?.downloads ?? [];

  return (
    <div className={`browser-panel${htmlFullscreen ? ' browser-fullscreen' : ''}`}>
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab, index) => (
          <div key={tab.id} role="presentation" className={`browser-tab${tab.id === activeTab?.id ? ' active' : ''}`} title={browserTabTitle(tab.title, tab.url)} draggable
            onDragStart={() => setDraggedTabId(tab.id)} onDragEnd={() => setDraggedTabId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (draggedTabId && draggedTabId !== tab.id) fireBrowser({ op: 'reorder-tab', tabId: draggedTabId, toIndex: index }); }}>
            <button role="tab" aria-selected={tab.id === activeTab?.id} aria-keyshortcuts="Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
              tabIndex={tab.id === activeTab?.id ? 0 : -1} className="browser-tab-select"
              ref={(node) => { if (node) tabButtonRefs.current.set(tab.id, node); else tabButtonRefs.current.delete(tab.id); }}
              onClick={() => fireBrowser({ op: 'select-tab', tabId: tab.id })} onKeyDown={(event) => tabKeyDown(event, index, tab)}>
              {tab.faviconUrl ? <img className="browser-tab-favicon" src={tab.faviconUrl} alt="" onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }} />
                : <span className="browser-tab-fallback"><Icon name="globe" size={12} /></span>}
              <span className="browser-tab-title">{browserTabTitle(tab.title, tab.url)}</span>
              <span className="browser-tab-state" aria-label={tab.crashed ? 'Tab crashed' : tab.loading ? 'Loading' : undefined}>
                {tab.crashed ? <span className="browser-tab-crashed">!</span> : tab.loading ? <span className="browser-tab-spinner" /> : null}
              </span>
            </button>
            {tab.audible && <button className="browser-tab-audio" aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'} title={tab.muted ? 'Unmute tab' : 'Mute tab'}
              onClick={() => void toggleTabMuted(tab)}>{tab.muted ? '×' : '♪'}</button>}
            <button className={`browser-tab-share${tab.sharedWithAgent ? ' on' : ''}`} aria-pressed={!!tab.sharedWithAgent}
              aria-label={tab.sharedWithAgent ? `Stop sharing ${browserTabTitle(tab.title, tab.url)} with the agent` : `Let the agent use ${browserTabTitle(tab.title, tab.url)}`}
              title={tab.sharedWithAgent ? 'Shared with the agent — click to take it back' : 'Let the agent use this tab'}
              onClick={(event) => { event.stopPropagation(); fireBrowser({ op: tab.sharedWithAgent ? 'unshare-tab' : 'share-tab', tabId: tab.id }); }}>
              <Icon name="brain" size={10} />
            </button>
            <button className="browser-tab-close" aria-label={`Close ${browserTabTitle(tab.title, tab.url)}`} title="Close tab (⌘W)"
              onClick={() => fireBrowser({ op: 'close-tab', tabId: tab.id })}>
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
        <button className="browser-tab-new" aria-label="New tab" title="New tab (⌘T)"
          onClick={() => fireBrowser({ op: 'create-tab', active: true }, () => requestAnimationFrame(() => omniboxRef.current?.focus()))}>
          <Icon name="plus" size={13} />
        </button>
        {(browserState?.closedTabCount ?? 0) > 0 && (
          <button className="browser-tab-new" aria-label="Reopen closed tab" title="Reopen closed tab (⌘⇧T)" onClick={() => fireBrowser({ op: 'reopen-tab' })}>
            <Icon name="refresh" size={12} />
          </button>
        )}
      </div>

      <div className="browser-topbar" role="toolbar" aria-label="Browser navigation">
        <button className="br-nav" title="Back (⌥←)" aria-label="Back" disabled={!activeTab?.canGoBack} onClick={() => fireBrowser({ op: 'back' })}><Icon name="arrow-left" size={14} /></button>
        <button className="br-nav" title="Forward (⌥→)" aria-label="Forward" disabled={!activeTab?.canGoForward} onClick={() => fireBrowser({ op: 'forward' })}><Icon name="arrow-right" size={14} /></button>
        <button className="br-nav" title={activeTab?.loading ? 'Stop loading' : 'Reload (⌘R)'} aria-label={activeTab?.loading ? 'Stop loading' : 'Reload'}
          disabled={!activeTab} onClick={() => fireBrowser(activeTab?.loading ? { op: 'stop' } : { op: 'reload' })}>
          <Icon name={activeTab?.loading ? 'stop' : 'refresh'} size={13} />
        </button>
        <button className="browser-origin-status" aria-label="Site information" aria-expanded={siteInfoOpen}
          onClick={() => setSiteInfoOpen((open) => !open)}
          title={activeTab?.url.startsWith('https://') ? 'Secure connection' : 'Page information'}><Icon name={activeTab?.url.startsWith('https://') ? 'shield' : 'globe'} size={13} /></button>
        {siteInfoOpen && activeTab && (
          <div className="browser-siteinfo" role="dialog" aria-label="Site information">
            <div className="browser-siteinfo-origin">{originOf(activeTab.url)}</div>
            <div className="browser-siteinfo-tls">
              {activeTab.url.startsWith('https://')
                ? 'Connection is encrypted (HTTPS).'
                : 'Connection is not encrypted — do not enter anything sensitive.'}
            </div>
            <div className="browser-siteinfo-actions">
              <button className="chip" onClick={() => { setSiteInfoOpen(false); fireBrowser({ op: 'clear-data', dataTypes: ['cookies', 'storage'] }); }}>
                Clear site data
              </button>
              <button className="chip" onClick={() => { setSiteInfoOpen(false); setDrawer('history'); void loadHistory(); }}>History</button>
            </div>
          </div>
        )}
        <div className="browser-omnibox">
          <input ref={omniboxRef} className="browser-url" value={urlDraft} aria-label="Address and search bar" placeholder="Search or enter address"
            spellCheck={false} autoComplete="off" role="combobox" aria-expanded={suggestOpen && suggestions.length > 0} aria-controls="browser-omnibox-suggestions"
            onChange={(event) => { setUrlDraft(event.target.value); setSuggestOpen(true); }}
            onFocus={(event) => { event.currentTarget.select(); setSuggestOpen(true); }}
            onBlur={() => { window.setTimeout(() => setSuggestOpen(false), 120); }}
            onKeyDown={(event) => {
              const rows = suggestions;
              if (event.key === 'ArrowDown' && rows.length) { event.preventDefault(); setSuggestIndex((i) => (i + 1) % rows.length); return; }
              if (event.key === 'ArrowUp' && rows.length) { event.preventDefault(); setSuggestIndex((i) => (i <= 0 ? rows.length : i) - 1); return; }
              if (event.key === 'Escape') { setSuggestOpen(false); return; }
              if (event.key === 'Enter') {
                event.preventDefault();
                const picked = suggestIndex >= 0 ? rows[suggestIndex] : undefined;
                setSuggestOpen(false);
                void go(picked ? picked.url : urlDraft);
              }
            }} />
          {suggestOpen && suggestions.length > 0 && (
            <ul className="browser-suggest" id="browser-omnibox-suggestions" role="listbox" aria-label="Address suggestions">
              {suggestions.map((row, index) => (
                <li key={row.url} role="option" aria-selected={index === suggestIndex}
                  className={`browser-suggest-row${index === suggestIndex ? ' active' : ''}`}
                  onMouseDown={(event) => { event.preventDefault(); setSuggestOpen(false); void go(row.url); }}>
                  <Icon name={row.source === 'bookmark' ? 'pin' : 'clock'} size={11} />
                  <span className="browser-suggest-title">{row.title}</span>
                  <span className="browser-suggest-url">{row.url}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="br-go" title="Go — navigate to the address, or search" aria-label="Go" onClick={() => void go(urlDraft)}>Go</button>
        <button className={`br-nav${activeBookmarked ? ' on' : ''}`} disabled={!activeTab}
          title={activeBookmarked ? 'Remove bookmark (⌘D)' : 'Bookmark this page (⌘D)'}
          aria-label={activeBookmarked ? 'Remove bookmark' : 'Bookmark this page'} aria-pressed={activeBookmarked}
          onClick={toggleBookmark}><Icon name="pin" size={13} /></button>
        <button className="br-nav" title="Find in page (⌘F)" aria-label="Find in page" onClick={() => { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()); }}><Icon name="search" size={13} /></button>
        <div className="browser-zoom" aria-label="Page zoom">
          <button aria-label="Zoom out" title="Zoom out (⌘−)" onClick={() => void changeZoom(-0.1)}>−</button>
          <span className="browser-zoom-label">{browserZoomLabel(activeTab?.zoomFactor)}</span>
          <button aria-label="Zoom in" title="Zoom in (⌘+)" onClick={() => void changeZoom(0.1)}>+</button>
        </div>
      </div>

      {findOpen && (
        <div className="browser-findbar" role="search">
          <input ref={findRef} value={findText} aria-label="Find text" placeholder="Find in page" onChange={(event) => setFindText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeFind();
              else if (event.key === 'Enter' && findText) runFind(!event.shiftKey);
            }} />
          <span className="browser-find-result" aria-live="polite">{findResult.matches == null ? (findResult.requestId ? 'searching' : '—') : `${findResult.activeMatchOrdinal ?? 0}/${findResult.matches}`}</span>
          <button className="br-nav" aria-label="Previous match" title="Previous match" disabled={!findText} onClick={() => runFind(false)}>↑</button>
          <button className="br-nav" aria-label="Next match" title="Next match" disabled={!findText} onClick={() => runFind(true)}>↓</button>
          <button className="br-nav" aria-label="Close find" title="Close find" onClick={closeFind}><Icon name="close" size={11} /></button>
        </div>
      )}

      {permission && (
        <div className="browser-promptbar" role="alertdialog" aria-label="Site permission request">
          <Icon name="shield" size={14} /><span><b>{permission.origin}</b> wants permission to use <b>{permission.permission}</b>.</span>
          {permission.permission === 'geolocation' && <span className="browser-prompt-note">Your choice is saved for this workspace and can be cleared by resetting the browser.</span>}
          <span className="browser-prompt-actions"><button className="chip" onClick={() => void respondPermission(false)}>Block</button><button className="br-go" onClick={() => void respondPermission(true)}>Allow</button></span>
        </div>
      )}
      {dialog && (
        <div className="browser-promptbar" role="alertdialog" aria-label={`${dialog.kind} dialog`}>
          <Icon name={dialog.kind === 'certificate' ? 'warn' : 'globe'} size={14} />
          <span>{dialog.origin ? <><b>{dialog.origin}</b> — </> : null}{dialog.message}</span>
          {dialog.kind === 'prompt' && <input className="browser-prompt-input" value={dialogValue} aria-label="Dialog response" onChange={(event) => setDialogValue(event.target.value)} />}
          {dialog.kind === 'certificate' && <span className="browser-prompt-note">The site’s identity cannot be verified. Proceeding can expose data to an attacker.</span>}
          <span className="browser-prompt-actions">
            {dialog.kind !== 'alert' && <button className="chip" onClick={() => void respondDialog(false)}>{dialog.kind === 'beforeunload' ? 'Stay' : dialog.kind === 'certificate' ? 'Go back' : 'Cancel'}</button>}
            <button className="br-go" onClick={() => void respondDialog(true)}>{dialog.kind === 'beforeunload' ? 'Leave' : dialog.kind === 'certificate' ? 'Proceed (unsafe)' : 'OK'}</button>
          </span>
        </div>
      )}

      <div className="browser-body">
        <div className="browser-rail" role="toolbar" aria-label="Browser developer tools">
          {railBtn('monitor', 'Agent uses this visible tab', false, () => setStatus('Agent browser tools are connected to this visible tab.'), !browser)}
          {railBtn('bolt', 'Extract test-id elements', drawer === 'elements', () => void doExtract(), !ready)}
          {railBtn('eye', pickMode ? 'Choosing an element…' : 'Inspect element snapshot', pickMode, startInspect, !ready)}
          {railBtn('search', highlightOn ? 'Clear element highlights' : 'Highlight test-id elements', highlightOn, () => void toggleHighlight(), !ready)}
          {railBtn('cursor', cursorOn ? 'Hide agent cursor' : 'Show agent cursor', cursorOn, () => setCursorOn((value) => !value), !activeTab)}
          <div className="br-rail-sep" />
          {railBtn('monitor', 'Desktop viewport', device === 'desktop', () => changeDevice('desktop'))}
          {railBtn('file', 'Tablet viewport', device === 'tablet', () => changeDevice('tablet'))}
          {railBtn('phone', 'Phone viewport', device === 'phone', () => changeDevice('phone'))}
          <div className="br-rail-sep" />
          {railBtn('terminal', 'Console', drawer === 'console', () => void doConsole(), !ready)}
          {railBtn('globe', 'Network', drawer === 'network', () => void doNetwork(), !ready)}
          {railBtn('file', 'Screenshot', drawer === 'shot', () => void doScreenshot(), !ready)}
          {railBtn('review', 'Accessibility tree', drawer === 'a11y', () => void doA11y(), !ready)}
          {railBtn('folder-open', `Downloads (${downloads.length})`, drawer === 'downloads', () => setDrawer('downloads'))}
          {railBtn('pin', `Bookmarks (${bookmarks.length})`, drawer === 'bookmarks', () => setDrawer('bookmarks'))}
          {railBtn('clock', 'History', drawer === 'history', () => { setDrawer('history'); void loadHistory(); })}
          {railBtn('file', 'Save as PDF — print this page into the workspace', false, () => {
            void runBrowser<{ path: string }>({ op: 'print' })
              .then((result) => setStatus(`Saved ${result.path}`))
              .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
          }, !ready)}
          <div className="br-rail-sep" />
          {railBtn('play', recording ? `Recording (${recorded.length})` : 'Record a flow', recording, () => setRecording((value) => !value))}
          {railBtn('clock', 'Flows', drawer === 'flows', () => setDrawer('flows'))}
          <div className="br-rail-sep" />
          {railBtn('trash', 'Reset browser — close every tab and clear cookies, cache, history & saved site permissions', false, () => {
            if (window.confirm('Reset the browser? This closes every tab and clears cookies, cache, history, and saved site permissions.')) {
              void runBrowser({ op: 'reset-browser' }).then(() => void refreshState()).catch((error) => setStatus(String(error)));
            }
          }, !browser)}
        </div>

        <div className="browser-stage">
          <div className={`browser-view dev-${device}`} style={effectiveW != null ? { maxWidth: effectiveW, margin: 0 } : undefined} ref={hostRef} aria-label="Browser page surface">
            {bridgeError && <div className="browser-native-placeholder error" role="alert">{bridgeError}</div>}
            {!bridgeError && !activeTab && <div className="browser-native-placeholder">Starting browser…</div>}
            {activeTab?.crashed && <div className="browser-native-placeholder error"><div className="browser-crash-card"><Icon name="warn" size={28} /><b>This tab crashed</b><span>The page process stopped unexpectedly. Your other tabs are unaffected.</span><button className="br-go" onClick={() => fireBrowser({ op: 'reload' })}>Reload tab</button></div></div>}
          </div>
          {/* Drag the right edge of a framed (device / custom-width) viewport to
              resize its width; double-click to snap back to the preset. */}
          {effectiveW != null && (
            <div
              className="browser-resize-x"
              style={{ left: effectiveW, bottom: drawer ? drawerH : 0 }}
              onPointerDown={onWidthResize}
              onDoubleClick={() => setCustomW(null)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize viewport width (double-click to reset)"
              title="Drag to resize the viewport width · double-click to reset"
            />
          )}
          {(status || picked) && <div className="browser-status" role="status" aria-live="polite">{picked && <span className="br-picked">{picked}</span>}{status && <span className="br-status-msg">{status}</span>}</div>}

          {drawer && (
            <div className="browser-drawer" style={{ height: drawerH }}>
              <div
                className="browser-resize-y"
                onPointerDown={onDrawerResize}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize drawer height"
                title="Drag to resize the panel height"
              />
              <div className="browser-drawer-head">
                <b>{drawer === 'bookmarks' ? `Bookmarks (${bookmarks.length})` : drawer === 'history' ? `History (${historyRows.length})` : drawer === 'elements' ? `Elements (${elements.length})` : drawer === 'console' ? `Console (${consoleMsgs.length})` : drawer === 'network' ? `Network (${network.length})` : drawer === 'a11y' ? `Accessibility (${a11y.length})` : drawer === 'shot' ? 'Screenshot' : drawer === 'downloads' ? `Downloads (${downloads.length})` : 'Flows'}</b>
                <span className="br-drawer-actions">
                  {drawer === 'console' && <button className="chip" onClick={() => void doConsole()}>refresh</button>}
                  {drawer === 'network' && <button className="chip" onClick={() => void doNetwork()}>refresh</button>}
                  {drawer === 'shot' && shot && <button className="chip" onClick={saveShot}>Save</button>}
                  {drawer === 'elements' && <input className="br-type" value={typeVal} onChange={(event) => setTypeVal(event.target.value)} title="Text used by type actions" />}
                  <button className="icon-btn" title="Close" aria-label="Close drawer" onClick={() => setDrawer(null)}><Icon name="close" size={11} /></button>
                </span>
              </div>
              <div className="browser-drawer-body">
                {drawer === 'elements' && (elements.length ? elements.map((element) => (
                  <div key={element.ref} className={`br-el${element.visible ? '' : ' hidden'}${element.target === drive ? ' focus' : ''}`}
                    onClick={() => { if (pickMode) { setPicked(`${element.role || element.tag} — ${element.label}`); setPickMode(false); hoverHighlight(element); } }}>
                    <span className="br-el-id">{element.target}</span><span className="br-el-type">{element.type || element.role || element.tag}</span>
                    {!element.visible && <span className="br-el-flag">hidden</span>}
                    <button className="br-el-run" onClick={(event) => { event.stopPropagation(); void runElement(element); }}>{element.action}</button>
                  </div>
                )) : <div className="br-empty">No matching elements are visible on this page.</div>)}

                {drawer === 'console' && (consoleMsgs.length ? consoleMsgs.slice().reverse().map((message, index) => (
                  <div key={`${message.at}-${index}`} className={`br-log lvl-${message.level.toLowerCase()}`}>{message.text}<span className="br-log-source">{message.source ? ` ${message.source}:${message.line}` : ''}</span></div>
                )) : <div className="br-empty">No console output captured.</div>)}

                {drawer === 'network' && (network.length ? network.slice().reverse().map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className={`br-net${entry.status >= 400 || entry.status === 0 ? ' fail' : ''}`}><span className="br-net-status">{entry.status || 'ERR'}</span><span className="br-net-method">{entry.method}</span><span className="br-net-url" title={entry.url}>{entry.url}</span><span className="br-net-ms">{entry.durationMs}ms</span></div>
                )) : <div className="br-empty">No requests captured.</div>)}

                {drawer === 'a11y' && (a11y.length ? a11y.map((node) => {
                  const source = rowSource(node, uiMap, activeUrl);
                  return (
                    <div key={node.ref} className="br-a11y" draggable title={`Drag into chat · ${source.ref}`}
                      onMouseEnter={() => hoverHighlight(node)} onMouseLeave={hoverClear}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', source.ref);
                        event.dataTransfer.setData('application/x-brainrouter-ref', source.ref);
                        event.dataTransfer.setData('application/x-brainrouter-tag', JSON.stringify({ name: node.name || node.testid || node.role, kind: source.kind, ref: source.ref, filePath: source.filePath, line: source.line }));
                        event.dataTransfer.effectAllowed = 'copy';
                      }}>
                      <Icon name={symbolKindIcon(source.kind)} size={12} className={`br-a11y-kind k-${source.kind ?? 'none'}`} />
                      <span className="br-a11y-role">{node.role}</span><span className="br-a11y-name">{node.name || '—'}</span>{node.testid && <span className="br-a11y-tid">{node.testid}</span>}
                      {source.filePath && <button className="br-a11y-src" title={`Open ${source.filePath}${source.line != null ? `:${source.line}` : ''}`} onClick={() => window.dispatchEvent(new CustomEvent('br-browser-openfile', { detail: { path: source.filePath, line: source.line } }))}>↪ source</button>}
                    </div>
                  );
                }) : <div className="br-empty">No accessibility nodes found.</div>)}

                {drawer === 'shot' && (shot ? <img className="br-shot" src={shot} alt="Current page screenshot" /> : <div className="br-empty">No screenshot yet.</div>)}

                {drawer === 'downloads' && (downloads.length ? downloads.slice().reverse().map((download) => {
                  const progress = download.totalBytes > 0 ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)) : null;
                  const paused = download.state === 'progressing' && pausedDownloads.has(download.id);
                  return <div className="br-download" key={download.id}><span className="br-download-name" title={download.filename}>{download.filename}</span><span className={`br-download-state s-${download.state}`}>{paused ? 'paused' : download.state}{progress != null && download.state === 'progressing' ? ` · ${progress}%` : ''}</span><span className="br-download-actions">{download.state === 'completed' && <><button className="chip" onClick={() => fireBrowser({ op: 'open-download', downloadId: download.id })}>Open</button><button className="chip" onClick={() => fireBrowser({ op: 'show-download', downloadId: download.id })}>Show</button></>}{download.state === 'progressing' && <><button className="chip" onClick={() => void toggleDownloadPaused(download.id, paused)}>{paused ? 'Resume' : 'Pause'}</button><button className="chip" onClick={() => fireBrowser({ op: 'cancel-download', downloadId: download.id })}>Cancel</button></>}</span></div>;
                }) : <div className="br-empty">No downloads yet.</div>)}

                {drawer === 'bookmarks' && (bookmarks.length ? bookmarks.map((entry) => (
                  <div className="br-place" key={entry.url}>
                    <button className="br-place-open" title={entry.url} onClick={() => void go(entry.url)}>{entry.title}</button>
                    <span className="br-place-url">{entry.url}</span>
                    <button className="chip" aria-label={`Remove bookmark ${entry.title}`}
                      onClick={() => fireBrowser({ op: 'remove-bookmark', url: entry.url })}>remove</button>
                  </div>
                )) : <div className="br-empty">No bookmarks yet — use the star in the toolbar.</div>)}

                {drawer === 'history' && (historyRows.length ? historyRows.map((entry) => (
                  <div className="br-place" key={entry.url}>
                    <button className="br-place-open" title={entry.url} onClick={() => void go(entry.url)}>{entry.title || entry.url}</button>
                    <span className="br-place-url">{entry.url}</span>
                    <span className="br-place-visits">{entry.visits > 1 ? `${entry.visits}×` : ''}</span>
                  </div>
                )) : <div className="br-empty">No history yet.</div>)}

                {drawer === 'flows' && <div className="br-flows">
                  {recorded.length > 0 && <div className="br-flow-save"><span>Recorded {recorded.length} step(s)</span><input className="br-type" placeholder="flow name" value={flowName} onChange={(event) => setFlowName(event.target.value)} /><button className="chip" onClick={saveFlow}>Save</button></div>}
                  {Object.keys(flows).length ? Object.keys(flows).map((name) => <div key={name} className="br-flow"><span>{name}</span><span className="br-flow-n">{flows[name].length} step(s)</span><button className="chip" onClick={() => void runFlow(name)}><Icon name="play" size={11} /> run</button></div>) : <div className="br-empty">No saved flows. Record actions, then save the flow.</div>}
                </div>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="browser-logs">
        <div className="browser-logs-head"><b>Logs</b><span className="browser-logs-n">{logs.length}</span><span className="browser-logs-actions"><button className="icon-btn" title={logsOpen ? 'Collapse logs' : 'Expand logs'} onClick={() => setLogsOpen((open) => !open)}>{logsOpen ? '▾' : '▴'}</button><button className="chip" onClick={() => setLogs([])}>clear</button></span></div>
        {logsOpen && <div className="browser-logs-body">{logs.length ? logs.slice().reverse().map((line, index) => <div key={logs.length - index} className={`browser-log-line${/(fail|error|stopped|refused|not found|unreachable|not ready)/i.test(line) ? ' err' : /(✓|finished|welcome|→ ok|OK )/i.test(line) ? ' ok' : ''}`}>{line}</div>) : <div className="br-empty">No activity yet.</div>}</div>}
      </div>
    </div>
  );
}
