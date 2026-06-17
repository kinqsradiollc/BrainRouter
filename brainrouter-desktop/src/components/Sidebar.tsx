/**
 * T4 — the left navigation rail: drag-to-resize grip, quick actions, the
 * current project's chats (with the per-chat ⋮ menu via renderSessionNode) +
 * grouped/archived sections, other projects (lazy-expand), add-project, and
 * the account row. Extracted verbatim from App.tsx; the App owns all state +
 * handlers and the renderSessionNode closure, passed through as props.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import { SessionStatus } from './SessionStatus.js';
import { fmtAge } from '../lib/format.js';
import { toggleVisible, moreLabel, showToggle } from '../lib/session/sessionPagination.js';
import type { SessionRow } from '../types.js';
import type { PanelId } from '../panels/Panel.js';

export interface SidebarProps {
  railAnim: { mounted: boolean; closing: boolean };
  railWidth: number;
  setRailOpen: Dispatch<SetStateAction<boolean>>;
  setRailWidth: Dispatch<SetStateAction<number>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  ensurePanel: (id: PanelId) => void;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  recentsSort: 'recent' | 'alpha';
  setRecentsSort: Dispatch<SetStateAction<'recent' | 'alpha'>>;
  workspaces: { current: string | null; recents: string[] };
  info: { workspaceRoot?: string; username?: string };
  currentProjectName: string;
  activeReviewBadge: string | null;
  prInfo: { number: number; state: string; title?: string } | null;
  recentsOpen: boolean;
  setRecentsOpen: Dispatch<SetStateAction<boolean>>;
  visibleProjectSessions: SessionRow[];
  renderSessionNode: (s: SessionRow, i: number) => React.ReactElement;
  hiddenProjectSessions: number;
  ungroupedSessions: SessionRow[];
  setVisibleCount: Dispatch<SetStateAction<number>>;
  groupedSessions: Array<[string, SessionRow[]]>;
  archivedCount: number;
  setShowArchived: Dispatch<SetStateAction<boolean>>;
  showArchived: boolean;
  otherProjects: string[];
  expandedProjects: string[];
  projSessions: Record<string, SessionRow[]>;
  runningWs: Set<string>;
  openProject: (root: string, resumeKey?: string) => void;
  toggleProject: (root: string) => void;
  addProject: () => void;
}

export function Sidebar(p: SidebarProps): React.ReactElement | null {
  const {
    railAnim, railWidth, setRailOpen, setRailWidth, setPaletteOpen, ensurePanel, setSidePanelOpen,
    recentsSort, setRecentsSort, workspaces, info, currentProjectName, activeReviewBadge, prInfo,
    recentsOpen, setRecentsOpen, visibleProjectSessions, renderSessionNode, hiddenProjectSessions,
    ungroupedSessions, setVisibleCount, groupedSessions, archivedCount, setShowArchived, showArchived,
    otherProjects, expandedProjects, projSessions, runningWs, openProject, toggleProject, addProject,
  } = p;
  if (!railAnim.mounted) return null;
  return (
    <nav className={`rail${railAnim.closing ? ' closing' : ''}`} style={{ width: railWidth }}>
      <div className="rail-grip" title="Drag to resize · drag far left to hide"
        onPointerDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = railWidth;
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
          // DESK-5k — Codex swipe-to-hide: dragging well past the minimum
          // collapses the sidebar (exit animation plays); width survives
          // for the next open.
          const move = (ev: PointerEvent) => {
            const w = startW + ev.clientX - startX;
            if (w < 165) { up(); setRailOpen(false); return; }
            setRailWidth(Math.max(220, Math.min(420, w)));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }} />
      <div className="rail-top">
        <button className="icon-btn" title="Toggle sidebar" onClick={() => setRailOpen(false)}><Icon name="layout" size={15} /></button>
        <button className="icon-btn" title="Search commands (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={14} /></button>
      </div>
      <div className="rail-card">
        <div className="rail-actions">
          <button className="rail-action primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}><Icon name="plus" size={13} />New chat</button>
          <button className="rail-action" title="Search chats" onClick={() => ensurePanel('search')}><Icon name="search" size={13} /></button>
          <button className="rail-action" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="command" size={13} /></button>
          <button className="rail-action" title="Workbench" onClick={() => setSidePanelOpen(true)}><Icon name="panels" size={13} /></button>
        </div>
        <div className="projects-head">
          <span>Projects</span>
          <button className="icon-btn" title={`Sort chats: ${recentsSort}`} onClick={() => setRecentsSort((s) => (s === 'recent' ? 'alpha' : 'recent'))}><Icon name="sort" size={12} /></button>
        </div>
        <div className="projects-scroll">
          <div className="project-block">
            <button className="project-row active" title={workspaces.current ?? info.workspaceRoot} onClick={() => setRecentsOpen((o) => !o)}>
              <Icon name="folder-open" size={15} />
              <span>{currentProjectName}</span>
              <span className="project-meta">
                {activeReviewBadge ? (
                  <span className={`review-badge rb-${activeReviewBadge}`} title={`Review: ${activeReviewBadge.replace('-', ' ')}`}>
                    {activeReviewBadge === 'blocked' ? '⚠' : activeReviewBadge === 'passed' ? '✓' : activeReviewBadge === 'stale' ? '↻' : activeReviewBadge === 'reviewing' ? '…' : '○'}
                  </span>
                ) : null}
                {prInfo ? (
                  <span className={`pr-chip ${prInfo.state.toLowerCase()}`}
                    title={`#${prInfo.number} · ${prInfo.state.charAt(0)}${prInfo.state.slice(1).toLowerCase()}${prInfo.title ? ` — ${prInfo.title}` : ''}`}>
                    <Icon name="merge" size={12} />
                  </span>
                ) : null}
                <Icon name={recentsOpen ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
              </span>
            </button>
            <div className="project-sessions">
              {/* DESK-5w/6m — chats (with per-chat ⋮ menu) + their nested
                  background tasks; pinned first, grouped sections below. */}
              {visibleProjectSessions.map((s, i) => renderSessionNode(s, i))}
              {!recentsOpen && hiddenProjectSessions > 0 ? (
                <button className="show-more" onClick={() => setRecentsOpen(true)}>{`Show ${hiddenProjectSessions} more`}</button>
              ) : recentsOpen && showToggle(ungroupedSessions.length, visibleProjectSessions.length) ? (
                <button className="show-more" onClick={() => setVisibleCount((c) => toggleVisible(c, ungroupedSessions.length))}>
                  {moreLabel(ungroupedSessions.length, visibleProjectSessions.length)}
                </button>
              ) : null}
              {/* DESK-6m — grouped chats as their own labeled sections. */}
              {groupedSessions.map(([group, items]) => (
                <div key={group} className="session-group">
                  <div className="session-group-head"><Icon name="folder" size={11} /><span>{group}</span><span className="dim">{items.length}</span></div>
                  {items.map((s, i) => renderSessionNode(s, i))}
                </div>
              ))}
              {archivedCount > 0 ? (
                <button className="show-more" onClick={() => setShowArchived((a) => !a)}>
                  {showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}
                </button>
              ) : null}
            </div>
          </div>
          {otherProjects.map((w) => {
            const open = expandedProjects.includes(w);
            const list = projSessions[w];
            return (
              <div key={w} className="project-block">
                <button className="project-row" title={runningWs.has(w) ? `${w} — running in the background` : w} onClick={() => toggleProject(w)}>
                  <Icon name={open ? 'folder-open' : 'folder'} size={15} />
                  <span>{w.split('/').pop()}</span>
                  <span className="project-meta">
                    {runningWs.has(w) ? <span className="ws-running-dot" title="Running in the background" /> : null}
                    <span className="icon-btn project-open" title="Open this project here"
                      onClick={(ev) => { ev.stopPropagation(); openProject(w); }}>
                      <Icon name="arrow-right" size={12} />
                    </span>
                    <Icon name={open ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
                  </span>
                </button>
                {open ? (
                  <div className="project-sessions">
                    {list === undefined ? <div className="proj-empty">Loading…</div>
                      : list.length === 0 ? <div className="proj-empty">No chats yet</div>
                      : list.slice(0, 6).map((s) => (
                        <button key={s.sessionKey} className="project-session" title={`${s.sessionKey} — opens ${w.split('/').pop()}`}
                          onClick={() => openProject(w, s.sessionKey)}>
                          <SessionStatus s={s} />
                          <span className="session-title">{s.firstUserMessage || s.sessionKey}</span>
                          {s.modifiedAt ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
                        </button>
                      ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          <button className="project-row add-project" onClick={addProject}><Icon name="folder-plus" size={15} /><span>Add project</span></button>
        </div>
      {/* DESK-5m — plain identity row: Settings lives in the top-right
          gear and All commands in ⌘K, so no menu and no chevron here. */}
      <div className="account-row" title={workspaces.current ?? info.workspaceRoot}>
        <span className="avatar">{(info.username ?? 'br').slice(0, 2)}</span>
        <span className="account-name">{info.username ?? 'BrainRouter'}</span>
      </div>
      </div>
    </nav>
  );
}
