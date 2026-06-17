/**
 * T4 — the right-hand views rail: drag-to-resize grip, the active panel's tab
 * strip + add-view menu + body (via renderPanelBody), or the view-chooser grid
 * when no tab is open. Extracted verbatim from App.tsx; the App owns the panel
 * state (usePanels) and the panel-body renderer, passed through as props.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import { PANEL_DEFS, type PanelId } from '../panels/index.js';
import { VIEW_MENU } from '../constants.js';
import type { PopId } from '../types.js';

export interface ViewsRailProps {
  sideAnim: { mounted: boolean; closing: boolean };
  sideWidth: number;
  setSideWidth: Dispatch<SetStateAction<number>>;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  activeSideTab: PanelId | null;
  sideTabs: PanelId[];
  setActiveSideTab: Dispatch<SetStateAction<PanelId | null>>;
  closeSideTab: (id: PanelId) => void;
  pop: PopId;
  setPop: Dispatch<SetStateAction<PopId>>;
  ensurePanel: (id: PanelId) => void;
  openBottomDock: () => void;
  tabTitle: (id: PanelId) => string;
  renderPanelBody: (id: PanelId) => React.ReactElement | null;
  openSideView: (id: PanelId) => void;
  lastPlan: { items: Array<{ status: string }> } | null;
  changedFiles: unknown[];
  activeSessionTasks: unknown[];
  fleet: unknown[];
  toolLog: unknown[];
  schedules: Array<{ enabled?: boolean }>;
  worktrees: unknown[];
  review: { findings: unknown[] } | null;
  ci: { checks: unknown[] };
}

export function ViewsRail(p: ViewsRailProps): React.ReactElement | null {
  const {
    sideAnim, sideWidth, setSideWidth, setSidePanelOpen, activeSideTab, sideTabs, setActiveSideTab, closeSideTab,
    pop, setPop, ensurePanel, openBottomDock, tabTitle, renderPanelBody, openSideView,
    lastPlan, changedFiles, activeSessionTasks, fleet, toolLog, schedules, worktrees, review, ci,
  } = p;
  if (!sideAnim.mounted) return null;
  return (
    <aside className={`views-rail${sideAnim.closing ? ' closing' : ''}`} style={{ width: sideWidth }}>
      <div className="col-grip" title="Drag to resize · drag far right to hide"
        onPointerDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = sideWidth;
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
          // DESK-5k — swipe-to-hide, mirroring the left rail's grip.
          const move = (ev: PointerEvent) => {
            const w = startW + (startX - ev.clientX);
            if (w < 215) { up(); setSidePanelOpen(false); return; }
            setSideWidth(Math.max(280, Math.min(760, w)));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }} />
      {activeSideTab ? (
        <>
          {/* DESK-5f — tabs, not windows: one view at a time, switchable */}
          <div className="side-tabs">
            {sideTabs.map((t) => (
              <button key={t} className={`term-tab${t === activeSideTab ? ' active' : ''}`} onClick={() => setActiveSideTab(t)}>
                <Icon name={PANEL_DEFS.find((d) => d.id === t)?.icon ?? 'file'} size={11} />
                <span className="tab-label">{tabTitle(t)}</span>
                <span className="icon-btn term-tab-x" onClick={(ev) => { ev.stopPropagation(); closeSideTab(t); }}><Icon name="close" size={9} /></span>
              </button>
            ))}
            <span className="pop-wrap">
              {pop === 'splus' ? (
                /* right-aligned: opens INTO the panel — a left-aligned
                   menu runs past the window edge when the panel is
                   the rightmost column */
                <div className="menu-pop down">
                  {VIEW_MENU.filter((v) => !sideTabs.includes(v.id)).map((v) => (
                    <button key={v.id} className="menu-item" onClick={() => { setPop(''); ensurePanel(v.id); }}>
                      <span className="mi-check"><Icon name={v.icon} size={13} /></span>{v.title}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => { setPop(''); openBottomDock(); }}>
                    <span className="mi-check"><Icon name="terminal" size={13} /></span>Terminal<span className="mi-hint">⌃`</span>
                  </button>
                </div>
              ) : null}
              <button className="icon-btn" title="Add view" onClick={() => setPop(pop === 'splus' ? '' : 'splus')}><Icon name="plus" size={12} /></button>
            </span>
            <span className="composer-spacer" />
          </div>
          <div className="side-body panel-body" key={activeSideTab}>{renderPanelBody(activeSideTab)}</div>
        </>
      ) : (
        /* DESK-5f — no tab yet: ask the user to choose a view (Codex) */
        <div className="side-chooser">
          {([
            { id: 'plan' as PanelId, title: 'Plan', hint: '⌃⇧G', icon: 'review',
              badge: lastPlan?.items.length ? `${lastPlan.items.filter((it) => it.status === 'completed').length}/${lastPlan.items.length}` : '' },
            { id: 'terminal' as PanelId, title: 'Terminal', hint: '⌃`', icon: 'terminal', badge: '' },
            { id: 'files' as PanelId, title: 'Files', hint: '⌘P', icon: 'folder', badge: '' },
            { id: 'diff' as PanelId, title: 'Changes', hint: '⇧⌘D', icon: 'diff',
              badge: changedFiles.length ? String(changedFiles.length) : '' },
            { id: 'tasks' as PanelId, title: 'Background tasks', hint: '', icon: 'tasks',
              badge: activeSessionTasks.length ? String(activeSessionTasks.length) : '', live: activeSessionTasks.length > 0 },
            { id: 'dashboard' as PanelId, title: 'Dashboard', hint: '', icon: 'tasks',
              badge: fleet.length ? String(fleet.length) : '' },
            { id: 'tools' as PanelId, title: 'Tool calls', hint: '', icon: 'bolt',
              badge: toolLog.length ? String(toolLog.length) : '' },
            { id: 'search' as PanelId, title: 'Search session', hint: '', icon: 'search', badge: '' },
            { id: 'schedule' as PanelId, title: 'Schedules', hint: '', icon: 'clock',
              badge: schedules.filter((s) => s.enabled).length ? String(schedules.filter((s) => s.enabled).length) : '' },
            { id: 'worktrees' as PanelId, title: 'Worktrees', hint: '', icon: 'branch',
              badge: worktrees.length ? String(worktrees.length) : '' },
            { id: 'review' as PanelId, title: 'Review', hint: '', icon: 'review',
              badge: review?.findings.length ? String(review.findings.length) : '' },
            { id: 'ci' as PanelId, title: 'CI / Checks', hint: '', icon: 'check-circle',
              badge: ci.checks.length ? String(ci.checks.length) : '' },
            { id: 'context' as PanelId, title: 'Context', hint: '', icon: 'layout-right', badge: '' },
          ] as Array<{ id: PanelId; title: string; hint: string; icon: string; badge: string; live?: boolean }>).map((l) => (
            <button key={l.id} className="side-launcher" onClick={() => openSideView(l.id)}>
              <Icon name={l.icon} size={18} />
              <span>{l.title}</span>
              <span className="launcher-meta">
                {l.live ? <span className="spinner sm" /> : null}
                {l.badge ? <span className="launcher-badge">{l.badge}</span> : null}
                {l.hint ? <kbd>{l.hint}</kbd> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
