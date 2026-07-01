/**
 * usePanels — the side-panel tabs + bottom terminal-dock state and all the
 * open/close/toggle/resize handlers, extracted verbatim from App.tsx (T4). The
 * App passes its `q` IPC helper so ensurePanel can refresh worktrees/review on
 * open; everything else is self-contained panel state.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { PanelId } from '../../panels/index.js';
import { devPanels, devFlag } from '../devFlags.js';
import { VALID_PANEL_IDS } from '../../constants.js';
import { clampSideRailWidth, reorderByValue, SIDE_RAIL_MIN } from './sideRailLayout.js';

// Persisted layouts can carry renamed/retired panel ids. The Markdown writing
// experience ('write' → 'docs') folded into the Editor, so both map to 'editor'.
// Unknown ids are dropped, and duplicates are collapsed, so an upgrade never
// leaves a dead or doubled tab.
const PANEL_ID_ALIASES: Record<string, PanelId> = { write: 'editor', docs: 'editor' };
const migratePanelId = (id: string): PanelId => (PANEL_ID_ALIASES[id] ?? id) as PanelId;
const migratePanelIds = (ids: unknown[]): PanelId[] => {
  const seen = new Set<PanelId>();
  return ids
    .map((p) => migratePanelId(String(p)))
    .filter((p) => VALID_PANEL_IDS.has(p) && !seen.has(p) && (seen.add(p), true));
};

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
  ensurePanel: (id: PanelId) => void;
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
  const [sideTabs, setSideTabs] = useState<PanelId[]>(() => {
    const saved = localStorage.getItem('br-side-tabs');
    if (saved !== null) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return migratePanelIds(parsed);
      } catch (e) {
        // ignore
      }
    }
    return devPanels();
  });
  const [activeSideTab, setActiveSideTab] = useState<PanelId | null>(() => {
    const saved = localStorage.getItem('br-active-side-tab');
    if (saved !== null && saved !== 'null') return migratePanelId(saved);
    return devPanels()[0] ?? null;
  });
  const [sidePanelOpen, setSidePanelOpen] = useState(() => {
    const saved = localStorage.getItem('br-side-open');
    if (saved !== null) return saved === '1';
    return devFlag('side') || devPanels().length > 0;
  });
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
    localStorage.setItem('br-side-open', sidePanelOpen ? '1' : '0');
  }, [sidePanelOpen]);

  useEffect(() => {
    localStorage.setItem('br-side-tabs', JSON.stringify(sideTabs));
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
  /** Show a view as the side panel's active tab (terminal lives in the dock). */
  function ensurePanel(id: PanelId): void {
    if (id === 'terminal') { openBottomDock(); return; }
    if (id === 'files') { q('q-list', 'list-files'); q('q-files', 'changed-files'); }
    if (id === 'worktrees') q('q-worktrees', 'git-worktrees'); // T13 — refresh on open
    if (id === 'review') q('q-review-current', 'review-current'); // Wave 5 — show gate + findings on open
    if (id === 'requirements') q('q-req', 'requirement-list'); // REQUIREMENT-RECORDS — list on open
    if (id === 'annotations') q('q-annot', 'annotation-list'); // ANNOTATION-RECORDS — list on open
    if (id === 'artifacts') { q('q-art', 'artifact-list'); q('q-annot', 'annotation-list'); } // ARTIFACT-RECORDS — list on open (+ annotations so §8 artifact annotations show)
    if (id === 'diff') q('q-review-current', 'review-current'); // Wave 7 — show the review gate in the Changes area
    setSideTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActiveSideTab(id);
    setSidePanelOpen(true);
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

  return {
    sideTabs, activeSideTab, sidePanelOpen, sideWidth, sideFullScreen, sidePinned, termDockOpen, termDockHeight, termTabs, activeTerm,
    setSideTabs, setActiveSideTab, setSidePanelOpen, setSideWidth, setSideFullScreen, setSidePinned, setTermDockOpen, setTermDockHeight, setTermTabs, setActiveTerm,
    ensurePanel, closeSideTab, reorderSideTab, togglePanel, openSideView, openBottomDock, addBottomTab, closeBottomTab, resizeTerminal, resetTermDock,
  };
}
