/**
 * T4 — the right-hand views rail: drag-to-resize grip, the active panel's tab
 * strip + add-view menu + body (via renderPanelBody), or the view-chooser grid
 * when no tab is open. Extracted verbatim from App.tsx; the App owns the panel
 * state (usePanels) and the panel-body renderer, passed through as props.
 */
import React, { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import { PANEL_DEFS, type PanelId } from '../../panels/index.js';
import { clampSideRailWidth, sideRailClassName } from '../../lib/panels/sideRailLayout.js';
import { usePlatform } from '../../lib/shortcuts/shortcuts.js';

const LAUNCHER_GROUPS = ['Work', 'Plan', 'Knowledge', 'Quality', 'Advanced'] as const;
type LauncherGroup = (typeof LAUNCHER_GROUPS)[number];

function setQuietDragImage(e: React.DragEvent<HTMLElement>): void {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  e.dataTransfer.setDragImage(canvas, 0, 0);
}

export interface ViewsRailProps {
  sideAnim: { mounted: boolean; closing: boolean };
  sideWidth: number;
  setSideWidth: Dispatch<SetStateAction<number>>;
  sideFullScreen: boolean;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  sidePinned: boolean;
  setSidePinned: Dispatch<SetStateAction<boolean>>;
  activeSideTab: PanelId | null;
  sideTabs: PanelId[];
  setActiveSideTab: Dispatch<SetStateAction<PanelId | null>>;
  closeSideTab: (id: PanelId) => void;
  reorderSideTab: (dragged: PanelId, target: PanelId) => void;
  tabTitle: (id: PanelId) => string;
  renderPanelBody: (id: PanelId) => React.ReactElement | null;
  openSideView: (id: PanelId) => void;
  lastPlan: { items: Array<{ status: string }> } | null;
  changedFiles: unknown[];
  backgroundTasks: unknown[];
  fleet: unknown[];
  toolLog: unknown[];
  schedules: Array<{ enabled?: boolean }>;
  worktrees: unknown[];
  review: { findings: unknown[] } | null;
  requirements: unknown[];
  annotations: Array<{ status: string }>;
  artifacts: Array<{ status: string }>;
  ci: { checks: unknown[] };
  envRoom?: boolean;
}

export function ViewsRail(p: ViewsRailProps): React.ReactElement | null {
  const {
    sideAnim, sideWidth, setSideWidth, sideFullScreen, setSidePanelOpen, sidePinned, setSidePinned, activeSideTab, sideTabs, setActiveSideTab, closeSideTab, reorderSideTab,
    tabTitle, renderPanelBody, openSideView,
    lastPlan, changedFiles, backgroundTasks, fleet, toolLog, schedules, worktrees, review, requirements, annotations, artifacts, ci,
    envRoom,
  } = p;
  const [draggedSideTab, setDraggedSideTab] = useState<PanelId | null>(null);
  const [dropSideTab, setDropSideTab] = useState<PanelId | null>(null);
  // §panel-search — filter + keyboard-select state for the tools chooser.
  const [chooserQuery, setChooserQuery] = useState('');
  const [chooserSel, setChooserSel] = useState(0);
  const chooserRef = useRef<HTMLDivElement | null>(null);
  const { fmt } = usePlatform(); // §shortcuts — OS-correct hint glyphs
  const lastDropSideTab = useRef<PanelId | null>(null);
  const clearSideDrag = (): void => {
    setDraggedSideTab(null);
    setDropSideTab(null);
    lastDropSideTab.current = null;
  };
  const reorderDraggedSideTab = (target: PanelId): void => {
    if (!draggedSideTab || draggedSideTab === target || lastDropSideTab.current === target) return;
    lastDropSideTab.current = target;
    setDropSideTab(target);
    reorderSideTab(draggedSideTab, target);
  };
  if (!sideAnim.mounted) return null;
  // §panel-search — the full tools list (badges from live props), filtered by the
  // chooser search box and keyboard-navigable (↑/↓ + Enter).
  const launchers = ([
    { id: 'files' as PanelId, title: 'Files', hint: fmt('Mod+P'), icon: 'folder', badge: '', group: 'Work' },
    { id: 'diff' as PanelId, title: 'Changes', hint: fmt('Mod+Shift+D'), icon: 'diff', group: 'Work',
      badge: changedFiles.length ? String(changedFiles.length) : '' },
    { id: 'terminal' as PanelId, title: 'Terminal', hint: fmt('Ctrl+Backtick'), icon: 'terminal', badge: '', group: 'Work' },
    { id: 'search' as PanelId, title: 'Search session', hint: '', icon: 'search', badge: '', group: 'Work' },
    { id: 'plan' as PanelId, title: 'Plan', hint: fmt('Mod+Shift+G'), icon: 'review', group: 'Plan',
      badge: lastPlan?.items.length ? `${lastPlan.items.filter((it) => it.status === 'completed').length}/${lastPlan.items.length}` : '' },
    { id: 'tasks' as PanelId, title: 'Tasks', hint: '', icon: 'tasks', group: 'Plan',
      badge: backgroundTasks.length ? String(backgroundTasks.length) : '', live: backgroundTasks.length > 0 },
    { id: 'workflows' as PanelId, title: 'Workflows', hint: '', icon: 'bolt', badge: '', group: 'Plan' },
    { id: 'schedule' as PanelId, title: 'Schedules', hint: '', icon: 'clock', group: 'Plan',
      badge: schedules.filter((s) => s.enabled).length ? String(schedules.filter((s) => s.enabled).length) : '' },
    { id: 'requirements' as PanelId, title: 'Requirements', hint: '', icon: 'tasks', group: 'Plan',
      badge: requirements.length ? String(requirements.length) : '' },
    { id: 'memory' as PanelId, title: 'Saved knowledge', hint: '', icon: 'pin', badge: '', group: 'Knowledge' },
    { id: 'knowledge' as PanelId, title: 'Project knowledge', hint: '', icon: 'brain', badge: '', group: 'Knowledge' },
    { id: 'context' as PanelId, title: 'Context', hint: '', icon: 'layout-right', badge: '', group: 'Knowledge' },
    { id: 'atlas' as PanelId, title: 'Atlas', hint: '', icon: 'atlas', badge: '', group: 'Knowledge' },
    { id: 'artifacts' as PanelId, title: 'Artifacts', hint: '', icon: 'file', group: 'Knowledge',
      badge: artifacts.filter((a) => a.status === 'draft').length ? String(artifacts.filter((a) => a.status === 'draft').length) : '' },
    { id: 'annotations' as PanelId, title: 'Annotations', hint: '', icon: 'review', group: 'Knowledge',
      badge: annotations.filter((a) => a.status === 'open').length ? String(annotations.filter((a) => a.status === 'open').length) : '' },
    { id: 'review' as PanelId, title: 'Review', hint: '', icon: 'review', group: 'Quality',
      badge: review?.findings.length ? String(review.findings.length) : '' },
    { id: 'ci' as PanelId, title: 'PR / Checks', hint: '', icon: 'check-circle', group: 'Quality',
      badge: ci.checks.length ? String(ci.checks.length) : '' },
    { id: 'prototype' as PanelId, title: 'Prototype', hint: '', icon: 'bolt', badge: '', group: 'Quality' },
    { id: 'tools' as PanelId, title: 'Tool calls', hint: '', icon: 'bolt', group: 'Advanced',
      badge: toolLog.length ? String(toolLog.length) : '' },
    { id: 'worktrees' as PanelId, title: 'Worktrees', hint: '', icon: 'branch', group: 'Advanced',
      badge: worktrees.length ? String(worktrees.length) : '' },
  ] as Array<{ id: PanelId; title: string; hint: string; icon: string; badge: string; group: LauncherGroup; live?: boolean }>);
  const cq = chooserQuery.trim().toLowerCase();
  const shownLaunchers = cq ? launchers.filter((l) => l.title.toLowerCase().includes(cq)) : launchers;
  const launchSel = shownLaunchers.length ? Math.min(Math.max(chooserSel, 0), shownLaunchers.length - 1) : 0;
  const setVisibleChooserSelection = (next: number): void => {
    setChooserSel(next);
    requestAnimationFrame(() => chooserRef.current?.querySelector<HTMLElement>(`[data-launch-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  return (
    <aside className={`${sideRailClassName(sideAnim.closing, sideFullScreen)}${!sidePinned && !sideFullScreen ? ' drawer' : ''}`} style={sideFullScreen ? undefined : { width: sideWidth }}>
      <div className="col-grip" title="Drag to resize · drag far right to hide"
        onPointerDown={(e) => {
          if (sideFullScreen) return;
          e.preventDefault();
          const startX = e.clientX;
          const startW = sideWidth;
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
          // DESK-5k — swipe-to-hide, mirroring the left rail's grip.
          const move = (ev: PointerEvent) => {
            const w = startW + (startX - ev.clientX);
            if (w < 215) { up(); setSidePanelOpen(false); return; }
            setSideWidth(clampSideRailWidth(w));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }} />
      {/* §panel-drawer — the header is ALWAYS present: a back-to-tools button
          (when inside a panel), the open tabs, then pin (dock⇄drawer) + close. */}
      <div className={`side-tabs side-head${envRoom ? ' has-env' : ''}`}>
        {activeSideTab ? null : (
          <span className="side-head-title">Views</span>
        )}
        {sideTabs.length ? (
          <div className="side-tabs-list">
              {sideTabs.map((t) => (
                <div key={t} className={`term-tab side-tab${t === activeSideTab ? ' active' : ''}${draggedSideTab === t ? ' dragging' : ''}${dropSideTab === t ? ' drop-target' : ''}`} draggable
                  onDragStart={(e) => {
                    setDraggedSideTab(t);
                    setDropSideTab(null);
                    lastDropSideTab.current = null;
                    e.dataTransfer.setData('application/x-br-side-tab', t);
                    e.dataTransfer.effectAllowed = 'move';
                    setQuietDragImage(e);
                  }}
                  onDragEnter={(e) => { e.preventDefault(); reorderDraggedSideTab(t); }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dragged = draggedSideTab ?? (e.dataTransfer.getData('application/x-br-side-tab') as PanelId);
                    if (dragged && dragged !== t && lastDropSideTab.current !== t) reorderSideTab(dragged, t);
                    clearSideDrag();
                  }}
                  onDragEnd={clearSideDrag}>
                  <button className="term-tab-main" onClick={() => setActiveSideTab(t)} title={tabTitle(t)}>
                    <Icon name={PANEL_DEFS.find((d) => d.id === t)?.icon ?? 'file'} size={11} />
                    <span className="tab-label">{tabTitle(t)}</span>
                  </button>
                  <button className="tab-close-btn term-tab-x" aria-label={`Close ${tabTitle(t)}`} title={`Close ${tabTitle(t)}`}
                    onClick={() => closeSideTab(t)}><Icon name="close" size={10} /></button>
                </div>
              ))}
            </div>
        ) : null}
        {!sideTabs.length && <div style={{ flex: 1 }} />}
        <button className={`side-head-btn${sidePinned ? ' active' : ''}`} aria-pressed={sidePinned}
          onClick={() => setSidePinned((v) => !v)}
          title={sidePinned ? 'Pinned — click to float as a drawer' : 'Drawer — click to pin (dock)'}>
          <Icon name="pin" size={13} />
        </button>
      </div>
      {activeSideTab ? (
        // §panel-persist — keep every open tab mounted (inactive ones hidden) so
        // switching tabs preserves each panel's state: drawers, scroll position,
        // and the Browser's native WebContentsView surface. Each panel is still a direct child of
        // its own `.side-body panel-body`, so no layout/CSS change is needed.
        <>{sideTabs.map((t) => (
          <div key={t} className="side-body panel-body" style={{ display: t === activeSideTab ? undefined : 'none' }}>
            {renderPanelBody(t)}
          </div>
        ))}</>
      ) : (
        /* §panel-drawer — no active tab: the searchable, keyboard-navigable tools chooser. */
        <div ref={chooserRef} className="side-chooser">
          <input className="chooser-search" autoFocus placeholder="Search views…" value={chooserQuery}
            role="combobox" aria-label="Search views" aria-autocomplete="list" aria-expanded="true"
            aria-controls="side-view-options"
            aria-activedescendant={shownLaunchers.length ? `side-launcher-${shownLaunchers[launchSel].id}` : undefined}
            onChange={(e) => { setChooserQuery(e.target.value); setVisibleChooserSelection(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setVisibleChooserSelection(Math.max(0, Math.min(launchSel + 1, shownLaunchers.length - 1))); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setVisibleChooserSelection(Math.max(launchSel - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); const l = shownLaunchers[launchSel]; if (l) { setChooserQuery(''); setChooserSel(0); openSideView(l.id); } }
              else if (e.key === 'Escape') { e.preventDefault(); if (chooserQuery) { setChooserQuery(''); setChooserSel(0); } else setSidePanelOpen(false); }
            }} />
          <div id="side-view-options" className="side-chooser-options" role="listbox" aria-label="Available views">
            {shownLaunchers.length === 0 ? <div className="chooser-empty" role="status">No views match “{chooserQuery}”.</div> : LAUNCHER_GROUPS.map((group) => {
              const groupLaunchers = shownLaunchers.filter((launcher) => launcher.group === group);
              if (!groupLaunchers.length) return null;
              return (
                <div key={group} className="side-launcher-group" data-group={group.toLowerCase()} role="group" aria-label={group}>
                  <div className="side-launcher-group-title" aria-hidden="true">{group}</div>
                  {groupLaunchers.map((l) => {
                    const i = shownLaunchers.indexOf(l);
                    return (
                      <button key={l.id} id={`side-launcher-${l.id}`} data-launch-index={i} role="option" aria-selected={i === launchSel}
                        className={`side-launcher${i === launchSel ? ' sel' : ''}`}
                        onClick={() => { setChooserQuery(''); setChooserSel(0); openSideView(l.id); }} onMouseMove={() => setChooserSel(i)}>
                        <Icon name={l.icon} size={18} />
                        <span>{l.title}</span>
                        <span className="launcher-meta">
                          {l.live ? <span className="live-dot" title="running" /> : null}
                          {l.badge ? <span className="launcher-badge">{l.badge}</span> : null}
                          {l.hint ? <kbd>{l.hint}</kbd> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
