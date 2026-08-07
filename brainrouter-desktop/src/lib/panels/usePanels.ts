/**
 * usePanels — the side-panel tabs + bottom terminal-dock state and all the
 * open/close/toggle/resize handlers, extracted verbatim from App.tsx (T4). The
 * App passes its `q` IPC helper so ensurePanel can refresh worktrees/review on
 * open; everything else is self-contained panel state.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { PanelId } from '../../panels/index.js';
import { devPanels, devFlag } from '../devFlags.js';
import { clampSideRailWidth, openWidthFor, reorderByValue, SIDE_RAIL_MIN } from './sideRailLayout.js';
import { LAST_SESSION_PANELS_KEY, migratePanelId, readLastSessionPanels } from './lastSessionPanels.js';

export interface TermTab { id: number; kind: 'shell' | PanelId }

export interface PanelsApi {
  sideTabs: PanelId[];
  activeSideTab: PanelId | null;
  sidePanelOpen: boolean;
  sideWidth: number;
  sideFullScreen: boolean;
  /** §panel-drawer — pinned = docked column (today's behavior); unpinned =
   *  transient overlay drawer that closes on outside-click / Esc. */
  sidePinned: boolean;
  termDockOpen: boolean;
  termDockHeight: number;
  termTabs: TermTab[];
  activeTerm: number;
  setSideTabs: Dispatch<SetStateAction<PanelId[]>>;
  setActiveSideTab: Dispatch<SetStateAction<PanelId | null>>;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  setSideWidth: Dispatch<SetStateAction<number>>;
  setSideFullScreen: Dispatch<SetStateAction<boolean>>;
  setSidePinned: Dispatch<SetStateAction<boolean>>;
  setTermDockOpen: Dispatch<SetStateAction<boolean>>;
  setTermDockHeight: Dispatch<SetStateAction<number>>;
  setTermTabs: Dispatch<SetStateAction<TermTab[]>>;
  setActiveTerm: Dispatch<SetStateAction<number>>;
  /** HUMAN intent: add, activate, open. */
  ensurePanel: (id: PanelId) => void;
  /** ADR-028 G1 — AGENT intent: make available, mark unread, do not take focus. */
  offerPanel: (id: PanelId) => void;
  markPanelRead: (id: PanelId) => void;
  unreadPanels: Set<PanelId>;
  /** ADR-028 G2 — bring back the previous session's panels, on request. */
  restoreLastSessionPanels: () => void;
  /**
   * What that action would reopen — empty when there is nothing to bring back.
   * The affordance has to know this: an always-present "reopen last session"
   * that silently does nothing is worse than not offering one.
   */
  lastSessionPanels: PanelId[];
  closeSideTab: (id: PanelId) => void;
  reorderSideTab: (dragged: PanelId, target: PanelId) => void;
  togglePanel: (id: PanelId) => void;
  openSideView: (id: PanelId) => void;
  openBottomDock: () => void;
  addBottomTab: (kind: 'shell' | PanelId) => void;
  closeBottomTab: (id: number) => void;
  resizeTerminal: (startHeight: number, startY: number, ev: React.PointerEvent) => void;
  /** Reset the dock to a single fresh shell (used when switching workspace). */
  resetTermDock: () => void;
}

export function usePanels(q: (id: string, name: string, args?: Record<string, unknown>) => void): PanelsApi {
  /**
   * ADR-028 G2 — the app starts with the panel CLOSED and no tabs open.
   *
   * These used to restore from localStorage, so a session that ended with six
   * tabs open started with six tabs open. Panel state is SESSION state, not
   * preference state: it reflects what you were doing an hour ago, not how you
   * want to work, and nobody ever prunes it. Width, the pinned flag and the
   * dock height ARE preferences and are still persisted below.
   *
   * The previous session's tabs are kept under a separate key so "reopen last
   * session's panels" can restore them — this removes an assumption, not a
   * capability.
   */
  // Read BEFORE this session's first write to the same key, which lands on mount
  // and would otherwise replace the record with the empty list G2 starts from.
  const [lastSessionPanels, setLastSessionPanels] = useState<PanelId[]>(readLastSessionPanels);
  const [sideTabs, setSideTabs] = useState<PanelId[]>(() => devPanels());
  const [activeSideTab, setActiveSideTab] = useState<PanelId | null>(() => devPanels()[0] ?? null);
  const [sidePanelOpen, setSidePanelOpen] = useState(() => devFlag('side') || devPanels().length > 0);
  // ADR-028 G1 — panels the agent made available that you have not looked at.
  const [unreadPanels, setUnreadPanels] = useState<Set<PanelId>>(() => new Set());
  // On launch, it starts at its minimum size (SIDE_RAIL_MIN).
  const [sideWidth, setSideWidth] = useState(SIDE_RAIL_MIN);
  const [sideFullScreen, setSideFullScreen] = useState(() => localStorage.getItem('br-side-fullscreen') === '1');
  // §panel-drawer — default DOCKED (pinned) so the panel is a persistent
  // resizable column that STAYS PUT when you click elsewhere; unpinning turns it
  // into an overlay drawer that dismisses on outside-click. A `-v2` key resets
  // the prior unpinned default (which persisted '0' on first mount) so existing
  // installs also get the docked behavior unless they explicitly unpin again.
  const [sidePinned, setSidePinned] = useState(() => localStorage.getItem('br-side-pinned-v2') !== '0');
  const [termDockOpen, setTermDockOpen] = useState(() => {
    const saved = localStorage.getItem('br-dock-open');
    if (saved !== null) return saved === '1';
    return devFlag('terminal');
  });
  // On launch, it starts at its minimum height (140).
  const [termDockHeight, setTermDockHeight] = useState(140);
  const [termTabs, setTermTabs] = useState<TermTab[]>([{ id: 1, kind: 'shell' }]);
  const [activeTerm, setActiveTerm] = useState(1);
  const termSeq = useRef(1);

  useEffect(() => {
    localStorage.setItem('br-side-w', String(clampSideRailWidth(sideWidth)));
  }, [sideWidth]);

  useEffect(() => {
    localStorage.setItem('br-side-fullscreen', sideFullScreen ? '1' : '0');
  }, [sideFullScreen]);

  useEffect(() => {
    localStorage.setItem('br-side-pinned-v2', sidePinned ? '1' : '0');
  }, [sidePinned]);

  useEffect(() => {
    // Recorded for the explicit "reopen last session's panels" action, NOT
    // read at startup — see G2.
    localStorage.setItem('br-side-open-last', sidePanelOpen ? '1' : '0');
  }, [sidePanelOpen]);

  const tabsRecorded = useRef(false);
  useEffect(() => {
    // Skip the mount write. G2 starts from an empty list, so recording it would
    // erase the previous session's tabs before anyone could ask for them back —
    // the restore existed but had nothing left to restore.
    if (!tabsRecorded.current) { tabsRecorded.current = true; return; }
    localStorage.setItem(LAST_SESSION_PANELS_KEY, JSON.stringify(sideTabs));
  }, [sideTabs]);

  useEffect(() => {
    localStorage.setItem('br-active-side-tab', activeSideTab ? String(activeSideTab) : 'null');
  }, [activeSideTab]);

  useEffect(() => {
    localStorage.setItem('br-dock-open', termDockOpen ? '1' : '0');
  }, [termDockOpen]);

  /** Open the bottom dock, re-seeding the default Terminal tab if all were closed. */
  function openBottomDock(): void {
    setTermTabs((tabs) => {
      if (tabs.length) return tabs;
      const id = ++termSeq.current;
      setActiveTerm(id);
      return [{ id, kind: 'shell' }];
    });
    setTermDockOpen(true);
  }
  /** Add (or focus) a bottom-dock tab; 'shell' always adds a fresh terminal. */
  function addBottomTab(kind: 'shell' | PanelId): void {
    setTermTabs((tabs) => {
      if (kind !== 'shell') {
        const existing = tabs.find((t) => t.kind === kind);
        if (existing) { setActiveTerm(existing.id); return tabs; }
      }
      const id = ++termSeq.current;
      setActiveTerm(id);
      return [...tabs, { id, kind }];
    });
    setTermDockOpen(true);
  }
  function closeBottomTab(id: number): void {
    setTermTabs((tabs) => {
      const next = tabs.filter((t) => t.id !== id);
      if (id === activeTerm && next.length) setActiveTerm(next[next.length - 1].id);
      if (next.length === 0) setTermDockOpen(false);
      return next;
    });
  }
  /**
   * ADR-028 G1 — the panel's data refresh, without any claim on your attention.
   *
   * Split out of `ensurePanel` so a caller can load a panel's data without also
   * deciding what you are looking at.
   */
  function refreshPanelData(id: PanelId): void {
    if (id === 'files') { q('q-list', 'list-files'); q('q-files', 'changed-files'); }
    if (id === 'worktrees') q('q-worktrees', 'git-worktrees'); // T13 — refresh on open
    if (id === 'review') q('q-review-current', 'review-current'); // Wave 5 — show gate + findings on open
    if (id === 'requirements') q('q-req', 'requirement-list'); // REQUIREMENT-RECORDS — list on open
    if (id === 'annotations') q('q-annot', 'annotation-list'); // ANNOTATION-RECORDS — list on open
    if (id === 'artifacts') { q('q-art', 'artifact-list'); q('q-annot', 'annotation-list'); } // ARTIFACT-RECORDS — list on open (+ annotations so §8 artifact annotations show)
    if (id === 'plan') q('q-annot', 'annotation-list'); // §plan-comments — load per-step comments on open
    if (id === 'diff') q('q-review-current', 'review-current'); // Wave 7 — show the review gate in the Changes area
  }

  /**
   * HUMAN intent: add the tab, make it active, open the panel.
   *
   * Called when a person asked for this panel — a click, a command, a keyboard
   * shortcut, or an interaction request that blocks the turn until they answer.
   */
  function ensurePanel(rawId: PanelId): void {
    if (rawId === 'terminal') { openBottomDock(); return; }
    // Aliased HERE rather than only on restore, so `ensurePanel('review')` from
    // any of its ten call sites opens the consolidated panel instead of a tab
    // that no longer exists.
    const id = migratePanelId(rawId);
    refreshPanelData(rawId);
    setSideTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActiveSideTab(id);
    setSidePanelOpen(true);
    // §panel-width — open certain panels (e.g. the Browser) at a comfortable
    // width; widen-only, so a manual resize is never overridden, and a no-op
    // returns the same number so React skips the re-render.
    setSideWidth((w) => openWidthFor(id, w));
  }

  /**
   * ADR-028 G1 — AGENT intent: make a panel available without taking focus.
   *
   * The bug this fixes: `ensurePanel` did three things at once, and 21 call
   * sites used it — many fired by agent activity. So the agent editing a file
   * yanked you off whatever you were reading. That is a claim about your
   * attention that nothing established, which is the thing this ADR objects to
   * everywhere else.
   *
   * The tab appears and is marked unread. Nothing else changes: not the active
   * tab, not whether the panel is open, not its width. The dot is how you learn
   * a diff is waiting without being moved to it.
   */
  function offerPanel(rawId: PanelId): void {
    if (rawId === 'terminal') return;
    const id = migratePanelId(rawId);
    refreshPanelData(rawId);
    setSideTabs((t) => (t.includes(id) ? t : [...t, id]));
    setUnreadPanels((u) => (u.has(id) || activeSideTab === id ? u : new Set([...u, id])));
  }

  /** Clear the dot once the person actually looks at the panel. */
  function markPanelRead(id: PanelId): void {
    setUnreadPanels((u) => {
      if (!u.has(id)) return u;
      const next = new Set(u);
      next.delete(id);
      return next;
    });
  }
  function closeSideTab(id: PanelId): void {
    setSideTabs((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (activeSideTab === id) setActiveSideTab(next[next.length - 1] ?? null);
      // Closing the last tab collapses the whole side panel (no separate close
      // 'x' — the per-tab × is the only close affordance, plus the rail toggle).
      if (next.length === 0) setSidePanelOpen(false);
      return next;
    });
  }
  function reorderSideTab(dragged: PanelId, target: PanelId): void {
    setSideTabs((tabs) => reorderByValue(tabs, dragged, target));
  }
  function togglePanel(id: PanelId): void {
    if (id === 'terminal') { setTermDockOpen((o) => !o); return; }
    if (sidePanelOpen && activeSideTab === id) { closeSideTab(id); return; }
    ensurePanel(id);
  }
  function openSideView(id: PanelId): void {
    if (id === 'terminal') { openBottomDock(); return; }
    ensurePanel(id);
  }
  function resizeTerminal(startHeight: number, startY: number, ev: React.PointerEvent): void {
    ev.preventDefault();
    const move = (e: PointerEvent) => {
      setTermDockHeight(Math.max(140, Math.min(Math.floor(window.innerHeight * 0.72), startHeight + startY - e.clientY)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function resetTermDock(): void {
    setTermDockOpen(false);
    setTermTabs([{ id: ++termSeq.current, kind: 'shell' }]);
    setActiveTerm(termSeq.current);
  }

  /**
   * ADR-028 G2 — bring back the previous session's panels, on request.
   *
   * The escape hatch for the case where restoring was actually wanted. Offered
   * rather than assumed, which is the whole difference.
   */
  function restoreLastSessionPanels(): void {
    if (lastSessionPanels.length === 0) return;
    setSideTabs(lastSessionPanels);
    setActiveSideTab(lastSessionPanels[0] ?? null);
    setSidePanelOpen(true);
    // Once restored they are simply the open tabs; offering to restore them
    // again would be offering the state you are already in.
    setLastSessionPanels([]);
  }

  return {
    lastSessionPanels,
    sideTabs, activeSideTab, sidePanelOpen, sideWidth, sideFullScreen, sidePinned, termDockOpen, termDockHeight, termTabs, activeTerm,
    setSideTabs, setActiveSideTab, setSidePanelOpen, setSideWidth, setSideFullScreen, setSidePinned, setTermDockOpen, setTermDockHeight, setTermTabs, setActiveTerm,
    ensurePanel, offerPanel, markPanelRead, unreadPanels, restoreLastSessionPanels,
    closeSideTab, reorderSideTab, togglePanel, openSideView, openBottomDock, addBottomTab, closeBottomTab, resizeTerminal, resetTermDock,
  };
}
