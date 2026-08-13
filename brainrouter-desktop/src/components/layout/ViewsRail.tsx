/**
 * T4 — the right-hand views rail: drag-to-resize grip, the active panel's tab
 * strip + add-view menu + body (via renderPanelBody), or the view-chooser grid
 * when no tab is open. Extracted verbatim from App.tsx; the App owns the panel
 * state (usePanels) and the panel-body renderer, passed through as props.
 */
import React, { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import { PANEL_DEFS, type PanelId } from '../../panels/index.js';
// ADR-028 G3 — the chooser groups by the CATALOG's taxonomy, deep-imported so
// this file does not pull the panel barrel's stylesheets. It used to carry its
// own `['Work','Plan','Knowledge','Quality','Advanced']`, so the app had two
// panel taxonomies, this was the only one a person ever saw, and the catalog's
// groups were read by nothing but their test.
import { PANEL_GROUPS, activeGroups, groupOf, panelsInGroup } from '../../panels/panelCatalog.js';
import { clampSideRailWidth, sideRailClassName } from '../../lib/panels/sideRailLayout.js';
import { usePlatform } from '../../lib/shortcuts/shortcuts.js';

const GROUP_LABELS = new Map(PANEL_GROUPS);

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
  renderPanelBody: (id: PanelId, active?: boolean) => React.ReactElement | null;
  openSideView: (id: PanelId) => void;
  /** ADR-028 G2 — the escape hatch for a launch where the clean start was not wanted. */
  restoreLastSessionPanels: () => void;
  lastSessionPanels: PanelId[];
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
    tabTitle, renderPanelBody, openSideView, restoreLastSessionPanels, lastSessionPanels,
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
  // ADR-028 G5 — ONE Pull request launcher. There used to be two, "Review" and
  // "PR / Checks", both of which opened this same panel; the Review one carried
  // a findings badge for a section the panel did not render. A badge counting
  // what the button will not show you is this ADR's defect in miniature.
  const prFindings = review?.findings.length ?? 0;
  const prBadge = [ci.checks.length, prFindings].filter((n) => n > 0).join(' · ');
  const launchers = ([
    { id: 'files' as PanelId, title: 'Files', hint: fmt('Mod+P'), icon: 'folder', badge: '' },
    { id: 'diff' as PanelId, title: 'Changes', hint: fmt('Mod+Shift+D'), icon: 'diff',
      badge: changedFiles.length ? String(changedFiles.length) : '' },
    { id: 'terminal' as PanelId, title: 'Terminal', hint: fmt('Ctrl+Backtick'), icon: 'terminal', badge: '' },
    { id: 'search' as PanelId, title: 'Search session', hint: '', icon: 'search', badge: '' },
    { id: 'plan' as PanelId, title: 'Plan', hint: fmt('Mod+Shift+G'), icon: 'review',
      badge: lastPlan?.items.length ? `${lastPlan.items.filter((it) => it.status === 'completed').length}/${lastPlan.items.length}` : '' },
    { id: 'tasks' as PanelId, title: 'Tasks', hint: '', icon: 'tasks',
      badge: backgroundTasks.length ? String(backgroundTasks.length) : '', live: backgroundTasks.length > 0 },
    { id: 'workflows' as PanelId, title: 'Workflows', hint: '', icon: 'bolt', badge: '' },
    { id: 'schedule' as PanelId, title: 'Schedules', hint: '', icon: 'clock',
      badge: schedules.filter((s) => s.enabled).length ? String(schedules.filter((s) => s.enabled).length) : '' },
    { id: 'stack' as PanelId, title: 'Pull request', hint: '', icon: 'branch', badge: prBadge },
    // ADR-034 — messages that arrive. `review` and `ci` are deliberately absent:
    // ADR-028 G5 retired them into the one `stack` entry above, whose badge
    // already carries both counts.
    { id: 'peers' as PanelId, title: 'Peers', hint: '', icon: 'bubble', badge: '' },
    { id: 'worktrees' as PanelId, title: 'Worktrees', hint: '', icon: 'branch',
      badge: worktrees.length ? String(worktrees.length) : '' },
    { id: 'requirements' as PanelId, title: 'Requirements', hint: '', icon: 'tasks',
      badge: requirements.length ? String(requirements.length) : '' },
    { id: 'memory' as PanelId, title: 'Saved knowledge', hint: '', icon: 'pin', badge: '' },
    { id: 'knowledge' as PanelId, title: 'Project knowledge', hint: '', icon: 'brain', badge: '' },
    { id: 'artifacts' as PanelId, title: 'Artifacts', hint: '', icon: 'file',
      badge: artifacts.filter((a) => a.status === 'draft').length ? String(artifacts.filter((a) => a.status === 'draft').length) : '' },
    { id: 'annotations' as PanelId, title: 'Annotations', hint: '', icon: 'review',
      badge: annotations.filter((a) => a.status === 'open').length ? String(annotations.filter((a) => a.status === 'open').length) : '' },
    // ADR-028 G4 — the Understand group is one panel, and this is how you reach
    // it without going through the topbar's overflow menu.
    { id: 'comprehension' as PanelId, title: 'Understand', hint: '', icon: 'brain', badge: '' },
    { id: 'context' as PanelId, title: 'Context', hint: '', icon: 'layout-right', badge: '' },
    { id: 'atlas' as PanelId, title: 'Atlas', hint: '', icon: 'atlas', badge: '' },
    { id: 'prototype' as PanelId, title: 'Prototype', hint: '', icon: 'bolt', badge: '' },
    { id: 'tools' as PanelId, title: 'Tool calls', hint: '', icon: 'bolt',
      badge: toolLog.length ? String(toolLog.length) : '' },
  ] as Array<{ id: PanelId; title: string; hint: string; icon: string; badge: string; live?: boolean }>);
  const cq = chooserQuery.trim().toLowerCase();
  const shownLaunchers = cq
    ? launchers.filter((l) => l.title.toLowerCase().includes(cq) || (GROUP_LABELS.get(groupOf(l.id)) ?? '').toLowerCase().includes(cq))
    : launchers;
  // Only the groups that still have a launcher after the filter, in catalog
  // order — an empty heading is a row that leads nowhere.
  const shownIds = shownLaunchers.map((l) => l.id);
  const shownGroups = activeGroups(shownIds);
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
            {renderPanelBody(t, t === activeSideTab)}
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
          {/* ADR-028 G2 — offered here because this chooser IS the launch state:
              the panel opens with no tabs, so the moment someone notices their
              layout is gone is the moment they are looking at this list. Shown
              only when there is something to bring back. */}
          {lastSessionPanels.length > 0 && !chooserQuery ? (
            <button type="button" className="side-restore-last" onClick={restoreLastSessionPanels}>
              <Icon name="clock" size={14} />
              <span>Reopen last session’s panels</span>
              <span className="launcher-meta">{lastSessionPanels.length}</span>
            </button>
          ) : null}
          <div id="side-view-options" className="side-chooser-options" role="listbox" aria-label="Available views">
            {shownLaunchers.length === 0 ? <div className="chooser-empty" role="status">No views match “{chooserQuery}”.</div> : shownGroups.map((group) => {
              const inGroup = new Set(panelsInGroup(group, shownIds));
              const groupLaunchers = shownLaunchers.filter((launcher) => inGroup.has(launcher.id));
              const label = GROUP_LABELS.get(group) ?? group;
              return (
                <div key={group} className="side-launcher-group" data-group={group} role="group" aria-label={label}>
                  <div className="side-launcher-group-title" aria-hidden="true">{label}</div>
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
