import {
  BROWSER_BLANK_URL,
  MAX_BROWSER_TABS,
  boundBrowserText,
  normalizeBrowserAddress,
  type BrowserTab,
  type BrowserTabId,
} from './protocol.js';

const MAX_RECENTLY_CLOSED = 25;
const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;

export interface BrowserTabModelTab extends BrowserTab {
  openerTabId: BrowserTabId | null;
  historyEntryCount: number;
  historyIndex: number;
}

export interface RecentlyClosedBrowserTab {
  tab: BrowserTabModelTab;
  index: number;
  closedAt: number;
}

export interface BrowserTabModel {
  tabs: BrowserTabModelTab[];
  activeTabId: BrowserTabId;
  recentlyClosed: RecentlyClosedBrowserTab[];
  /** Monotonic allocator cursor. IDs below this value are never allocated anew. */
  nextTabSequence: number;
}

export interface BrowserTabRestore {
  id?: BrowserTabId;
  url?: string;
  title?: string;
  faviconUrl?: string | null;
  muted?: boolean;
  zoomFactor?: number;
  lastAccessedAt?: number;
  openerTabId?: BrowserTabId | null;
}

export interface BrowserTabModelRestore {
  tabs: readonly BrowserTabRestore[];
  activeTabId?: BrowserTabId;
}

export type BrowserTabModelAction =
  | { type: 'create'; url?: string; active?: boolean; openerTabId?: BrowserTabId | null; now?: number }
  | { type: 'popup'; url?: string; openerTabId: BrowserTabId; active?: boolean; now?: number }
  | { type: 'select'; tabId: BrowserTabId; now?: number }
  | { type: 'close'; tabId?: BrowserTabId; now?: number }
  | { type: 'reopen'; now?: number }
  | { type: 'reorder'; tabId: BrowserTabId; toIndex: number }
  | { type: 'restore'; tabs: readonly BrowserTabRestore[]; activeTabId?: BrowserTabId }
  | {
      type: 'metadata';
      tabId: BrowserTabId;
      title?: string;
      faviconUrl?: string | null;
      loading?: boolean;
      audible?: boolean;
      muted?: boolean;
      zoomFactor?: number;
    }
  | {
      type: 'history';
      tabId: BrowserTabId;
      canGoBack: boolean;
      canGoForward: boolean;
      entryCount: number;
      currentIndex: number;
    }
  | {
      type: 'navigation-committed';
      tabId: BrowserTabId;
      url: string;
      title?: string;
      now?: number;
    }
  | { type: 'crashed'; tabId: BrowserTabId }
  | { type: 'recover'; tabId: BrowserTabId; now?: number };

function finiteNonNegative(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function safeNow(value: number | undefined): number {
  return finiteNonNegative(value);
}

function safeZoom(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, Number(value)));
}

function safeTabId(value: unknown): value is BrowserTabId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function safeUrl(value: string | undefined): string {
  return normalizeBrowserAddress(value) ?? BROWSER_BLANK_URL;
}

function sequenceFromId(id: BrowserTabId): number | null {
  const match = /^tab_(\d+)$/.exec(id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function allocateTabId(model: Pick<BrowserTabModel, 'tabs' | 'recentlyClosed' | 'nextTabSequence'>): {
  id: BrowserTabId;
  nextTabSequence: number;
} {
  const unavailable = new Set<BrowserTabId>([
    ...model.tabs.map((tab) => tab.id),
    ...model.recentlyClosed.map((entry) => entry.tab.id),
  ]);
  let sequence = Math.max(1, Math.floor(model.nextTabSequence));
  let id = `tab_${sequence}`;
  while (unavailable.has(id)) {
    sequence += 1;
    id = `tab_${sequence}`;
  }
  return { id, nextTabSequence: sequence + 1 };
}

function blankTab(id: BrowserTabId, now: number, options?: {
  url?: string;
  openerTabId?: BrowserTabId | null;
}): BrowserTabModelTab {
  return {
    id,
    url: safeUrl(options?.url),
    title: 'New tab',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    audible: false,
    muted: false,
    zoomFactor: DEFAULT_ZOOM_FACTOR,
    revision: 1,
    lastAccessedAt: now,
    openerTabId: options?.openerTabId ?? null,
    historyEntryCount: 1,
    historyIndex: 0,
  };
}

function restoredTab(input: BrowserTabRestore, id: BrowserTabId): BrowserTabModelTab {
  return {
    ...blankTab(id, safeNow(input.lastAccessedAt), {
      url: input.url,
      openerTabId: input.openerTabId,
    }),
    title: boundBrowserText(input.title?.trim() || 'New tab'),
    faviconUrl: input.faviconUrl ? boundBrowserText(input.faviconUrl) : null,
    muted: input.muted === true,
    zoomFactor: safeZoom(input.zoomFactor),
  };
}

function buildRestoredModel(restore?: BrowserTabModelRestore): BrowserTabModel {
  const tabs: BrowserTabModelTab[] = [];
  const seen = new Set<BrowserTabId>();
  let nextTabSequence = 1;

  for (const input of restore?.tabs ?? []) {
    if (tabs.length >= MAX_BROWSER_TABS) break;
    let id = safeTabId(input.id) ? input.id : `tab_${nextTabSequence}`;
    while (seen.has(id)) {
      if (safeTabId(input.id)) {
        id = '';
        break;
      }
      nextTabSequence += 1;
      id = `tab_${nextTabSequence}`;
    }
    if (!id) continue;
    seen.add(id);
    const parsedSequence = sequenceFromId(id);
    if (parsedSequence !== null) nextTabSequence = Math.max(nextTabSequence, parsedSequence + 1);
    tabs.push(restoredTab(input, id));
  }

  if (tabs.length === 0) {
    const id = `tab_${nextTabSequence}`;
    tabs.push(blankTab(id, 0));
    nextTabSequence += 1;
  }

  const validIds = new Set(tabs.map((tab) => tab.id));
  const normalizedTabs = tabs.map((tab) => (
    tab.openerTabId && !validIds.has(tab.openerTabId)
      ? { ...tab, openerTabId: null }
      : tab
  ));
  const requestedActive = restore?.activeTabId;
  const activeTabId = requestedActive && validIds.has(requestedActive)
    ? requestedActive
    : normalizedTabs[0].id;

  return {
    tabs: normalizedTabs,
    activeTabId,
    recentlyClosed: [],
    nextTabSequence,
  };
}

/** Create a valid model. Persisted metadata is treated as untrusted and bounded. */
export function createTabModel(restored?: BrowserTabModelRestore): BrowserTabModel {
  return buildRestoredModel(restored);
}

/** The reducer invariant guarantees this always succeeds. */
export function activeTab(model: BrowserTabModel): BrowserTabModelTab {
  const tab = model.tabs.find((candidate) => candidate.id === model.activeTabId) ?? model.tabs[0];
  if (!tab) throw new Error('browser tab model must contain at least one tab');
  return tab;
}

function updateTab(
  model: BrowserTabModel,
  tabId: BrowserTabId,
  update: (tab: BrowserTabModelTab) => BrowserTabModelTab,
): BrowserTabModel {
  const index = model.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return model;
  const previous = model.tabs[index];
  const next = update(previous);
  if (next === previous) return model;
  const tabs = model.tabs.slice();
  tabs[index] = next;
  return { ...model, tabs };
}

function createTab(
  model: BrowserTabModel,
  action: Extract<BrowserTabModelAction, { type: 'create' | 'popup' }>,
): BrowserTabModel {
  if (model.tabs.length >= MAX_BROWSER_TABS) return model;
  if (action.type === 'popup' && !model.tabs.some((tab) => tab.id === action.openerTabId)) return model;

  const allocation = allocateTabId(model);
  const openerTabId = action.type === 'popup' ? action.openerTabId : action.openerTabId ?? null;
  const tab = blankTab(allocation.id, safeNow(action.now), { url: action.url, openerTabId });
  const shouldActivate = action.active !== false;
  const tabs = model.tabs.slice();
  if (action.type === 'popup') {
    const openerIndex = tabs.findIndex((candidate) => candidate.id === action.openerTabId);
    tabs.splice(openerIndex + 1, 0, tab);
  } else {
    tabs.push(tab);
  }
  return {
    ...model,
    tabs,
    activeTabId: shouldActivate ? tab.id : model.activeTabId,
    nextTabSequence: allocation.nextTabSequence,
  };
}

function closeTab(model: BrowserTabModel, tabId: BrowserTabId, now: number): BrowserTabModel {
  const index = model.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return model;
  const closed = model.tabs[index];
  const recentlyClosed = [
    ...model.recentlyClosed,
    { tab: closed, index, closedAt: now },
  ].slice(-MAX_RECENTLY_CLOSED);

  if (model.tabs.length === 1) {
    const allocation = allocateTabId({ ...model, recentlyClosed });
    const replacement = blankTab(allocation.id, now);
    return {
      ...model,
      tabs: [replacement],
      activeTabId: replacement.id,
      recentlyClosed,
      nextTabSequence: allocation.nextTabSequence,
    };
  }

  const tabs = model.tabs.filter((tab) => tab.id !== tabId);
  let activeTabId = model.activeTabId;
  if (tabId === model.activeTabId) {
    activeTabId = model.tabs[index + 1]?.id ?? model.tabs[index - 1]!.id;
  }
  return { ...model, tabs, activeTabId, recentlyClosed };
}

function reopenTab(model: BrowserTabModel, now: number): BrowserTabModel {
  if (model.tabs.length >= MAX_BROWSER_TABS || model.recentlyClosed.length === 0) return model;
  const entry = model.recentlyClosed.at(-1)!;
  const alreadyOpen = model.tabs.some((tab) => tab.id === entry.tab.id);
  if (alreadyOpen) return { ...model, recentlyClosed: model.recentlyClosed.slice(0, -1) };

  const tab: BrowserTabModelTab = {
    ...entry.tab,
    loading: true,
    crashed: false,
    revision: entry.tab.revision + 1,
    lastAccessedAt: now,
  };
  const tabs = model.tabs.slice();
  tabs.splice(Math.min(entry.index, tabs.length), 0, tab);
  return {
    ...model,
    tabs,
    activeTabId: tab.id,
    recentlyClosed: model.recentlyClosed.slice(0, -1),
  };
}

export function reduceTabModel(model: BrowserTabModel, action: BrowserTabModelAction): BrowserTabModel {
  switch (action.type) {
    case 'create':
    case 'popup':
      return createTab(model, action);
    case 'select':
      if (action.tabId === model.activeTabId) {
        return updateTab(model, action.tabId, (tab) => ({ ...tab, lastAccessedAt: safeNow(action.now) }));
      }
      if (!model.tabs.some((tab) => tab.id === action.tabId)) return model;
      return {
        ...updateTab(model, action.tabId, (tab) => ({ ...tab, lastAccessedAt: safeNow(action.now) })),
        activeTabId: action.tabId,
      };
    case 'close':
      return closeTab(model, action.tabId ?? model.activeTabId, safeNow(action.now));
    case 'reopen':
      return reopenTab(model, safeNow(action.now));
    case 'reorder': {
      const fromIndex = model.tabs.findIndex((tab) => tab.id === action.tabId);
      if (fromIndex < 0) return model;
      const toIndex = Math.min(model.tabs.length - 1, Math.max(0, Math.floor(action.toIndex)));
      if (fromIndex === toIndex) return model;
      const tabs = model.tabs.slice();
      const [tab] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, tab);
      return { ...model, tabs };
    }
    case 'restore': {
      const restored = buildRestoredModel({ tabs: action.tabs, activeTabId: action.activeTabId });
      return {
        ...restored,
        nextTabSequence: Math.max(model.nextTabSequence, restored.nextTabSequence),
      };
    }
    case 'metadata':
      return updateTab(model, action.tabId, (tab) => ({
        ...tab,
        title: action.title === undefined ? tab.title : boundBrowserText(action.title.trim() || 'New tab'),
        faviconUrl: action.faviconUrl === undefined
          ? tab.faviconUrl
          : action.faviconUrl
            ? boundBrowserText(action.faviconUrl)
            : null,
        loading: action.loading ?? tab.loading,
        audible: action.audible ?? tab.audible,
        muted: action.muted ?? tab.muted,
        zoomFactor: action.zoomFactor === undefined ? tab.zoomFactor : safeZoom(action.zoomFactor),
      }));
    case 'history': {
      const entryCount = Math.max(0, Math.floor(finiteNonNegative(action.entryCount)));
      const historyIndex = entryCount === 0
        ? -1
        : Math.min(entryCount - 1, Math.max(0, Math.floor(finiteNonNegative(action.currentIndex))));
      return updateTab(model, action.tabId, (tab) => ({
        ...tab,
        canGoBack: action.canGoBack,
        canGoForward: action.canGoForward,
        historyEntryCount: entryCount,
        historyIndex,
      }));
    }
    case 'navigation-committed': {
      const url = normalizeBrowserAddress(action.url);
      if (!url) return model;
      return updateTab(model, action.tabId, (tab) => ({
        ...tab,
        url,
        title: action.title === undefined ? tab.title : boundBrowserText(action.title.trim() || 'New tab'),
        loading: false,
        crashed: false,
        revision: tab.revision + 1,
        lastAccessedAt: safeNow(action.now),
      }));
    }
    case 'crashed':
      return updateTab(model, action.tabId, (tab) => ({
        ...tab,
        loading: false,
        crashed: true,
        revision: tab.revision + 1,
      }));
    case 'recover':
      return updateTab(model, action.tabId, (tab) => ({
        ...tab,
        loading: true,
        crashed: false,
        revision: tab.revision + 1,
        lastAccessedAt: safeNow(action.now),
      }));
    default:
      return model;
  }
}
