/**
 * usePanels — the side-panel tabs + bottom terminal-dock state and all the
 * open/close/toggle/resize handlers, extracted verbatim from App.tsx (T4). The
 * App passes its `q` IPC helper so ensurePanel can refresh worktrees/review on
 * open; everything else is self-contained panel state.
 */
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { PanelId } from '../../panels/index.js';
import { devPanels, devFlag } from '../devFlags.js';

export interface TermTab { id: number; kind: 'shell' | PanelId }

export interface PanelsApi {
  sideTabs: PanelId[];
  activeSideTab: PanelId | null;
  sidePanelOpen: boolean;
  sideWidth: number;
  termDockOpen: boolean;
  termDockHeight: number;
  termTabs: TermTab[];
  activeTerm: number;
  setSideTabs: Dispatch<SetStateAction<PanelId[]>>;
  setActiveSideTab: Dispatch<SetStateAction<PanelId | null>>;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  setSideWidth: Dispatch<SetStateAction<number>>;
  setTermDockOpen: Dispatch<SetStateAction<boolean>>;
  setTermDockHeight: Dispatch<SetStateAction<number>>;
  setTermTabs: Dispatch<SetStateAction<TermTab[]>>;
  setActiveTerm: Dispatch<SetStateAction<number>>;
  ensurePanel: (id: PanelId) => void;
  closeSideTab: (id: PanelId) => void;
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
  const [sideTabs, setSideTabs] = useState<PanelId[]>(() => devPanels());
  const [activeSideTab, setActiveSideTab] = useState<PanelId | null>(() => devPanels()[0] ?? null);
  const [sidePanelOpen, setSidePanelOpen] = useState(() => devFlag('side') || devPanels().length > 0);
  const [sideWidth, setSideWidth] = useState(330);
  const [termDockOpen, setTermDockOpen] = useState(() => devFlag('terminal'));
  const [termDockHeight, setTermDockHeight] = useState(210);
  const [termTabs, setTermTabs] = useState<TermTab[]>([{ id: 1, kind: 'shell' }]);
  const [activeTerm, setActiveTerm] = useState(1);
  const termSeq = useRef(1);

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
    if (id === 'worktrees') q('q-worktrees', 'git-worktrees'); // T13 — refresh on open
    if (id === 'review') q('q-review-current', 'review-current'); // Wave 5 — show gate + findings on open
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
    sideTabs, activeSideTab, sidePanelOpen, sideWidth, termDockOpen, termDockHeight, termTabs, activeTerm,
    setSideTabs, setActiveSideTab, setSidePanelOpen, setSideWidth, setTermDockOpen, setTermDockHeight, setTermTabs, setActiveTerm,
    ensurePanel, closeSideTab, togglePanel, openSideView, openBottomDock, addBottomTab, closeBottomTab, resizeTerminal, resetTermDock,
  };
}
