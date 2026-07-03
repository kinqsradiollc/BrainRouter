/**
 * T4 — the left navigation rail: drag-to-resize grip, quick actions, the
 * fixed-order projects, the current project's chats (with the per-chat ⋮ menu
 * via renderSessionNode) + grouped/archived sections, add-project, and
 * the account row. Extracted verbatim from App.tsx; the App owns all state +
 * handlers and the renderSessionNode closure, passed through as props.
 */
import React, { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import { SessionStatus } from '../status/SessionStatus.js';
import { fmtAge } from '../../lib/format.js';
import { toggleVisible, moreLabel, showToggle } from '../../lib/session/list/sessionPagination.js';
import {
  PROJECT_SESSION_BASE,
  filterProjectSessions,
  nextProjectVisibleCount,
  projectMatches,
  projectMoreLabel,
  shouldShowProjectToggle,
  visibleProjectSessions as visibleOtherProjectSessions,
  type ProjectSessionsByRoot,
} from '../../lib/session/workspaces/projectSessionsView.js';
import type { SessionRow } from '../../types.js';
import type { PanelId } from '../../panels/Panel.js';

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
  projectRoots: string[];
  activeReviewBadge: string | null;
  prInfo: { number: number; state: string; title?: string } | null;
  recentsOpen: boolean;
  setRecentsOpen: Dispatch<SetStateAction<boolean>>;
  visibleProjectSessions: SessionRow[];
  renderSessionNode: (s: SessionRow, i: number) => React.ReactElement;
  /** WS-UX — open the per-chat ⋮ menu for a session in a NON-active workspace
   *  (parked project): pass its row + workspace root so the menu acts on it
   *  without switching workspaces. */
  openSessionMenu: (e: React.MouseEvent, key: string, opts?: { row?: SessionRow; root?: string }) => void;
  /** WS-UX — inline-rename state, so a parked-project chat can be renamed in place. */
  renamingKey: string | null;
  renameDraft: string;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenamingKey: Dispatch<SetStateAction<string | null>>;
  commitRename: () => void;
  hiddenProjectSessions: number;
  ungroupedSessions: SessionRow[];
  setVisibleCount: Dispatch<SetStateAction<number>>;
  groupedSessions: Array<[string, SessionRow[]]>;
  archivedCount: number;
  setShowArchived: Dispatch<SetStateAction<boolean>>;
  showArchived: boolean;
  expandedProjects: string[];
  projSessions: ProjectSessionsByRoot;
  runningWs: Set<string>;
  /** WS3 — sessionKeys with a turn in flight, ACROSS all workspaces, so a parked
   *  project's chat shows a live spinner instead of a stale dot. */
  runningSessions: string[];
  /** Fix 4 / §3 — count of ACTIVE background tasks per workspace (durable + live),
   *  so a non-active workspace shows how much is running, not just a dot. */
  workspaceRunCount?: Map<string, number>;
  openProject: (root: string, resumeKey?: string) => void;
  toggleProject: (root: string) => void;
  reorderProject: (dragged: string, target: string) => void;
  addProject: () => void;
  /** Workspace mode — Chat · Track · Code (the left-sidebar switcher). */
  mode: 'chat' | 'track' | 'code';
  setMode: Dispatch<SetStateAction<'chat' | 'track' | 'code'>>;
}

export function Sidebar(p: SidebarProps): React.ReactElement | null {
  const {
    railAnim, railWidth, setRailOpen, setRailWidth, setPaletteOpen, ensurePanel, setSidePanelOpen,
    recentsSort, setRecentsSort, workspaces, info, projectRoots, activeReviewBadge, prInfo,
    recentsOpen, setRecentsOpen, visibleProjectSessions, renderSessionNode, openSessionMenu, hiddenProjectSessions,
    renamingKey, renameDraft, setRenameDraft, setRenamingKey, commitRename,
    ungroupedSessions, setVisibleCount, groupedSessions, archivedCount, setShowArchived, showArchived,
    expandedProjects, projSessions, runningWs, runningSessions, workspaceRunCount, openProject, toggleProject, reorderProject, addProject,
  } = p;
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({});
  const [draggingProject, setDraggingProject] = useState<string | null>(null);
  const [dropTargetProject, setDropTargetProject] = useState<string | null>(null);
  const query = projectQuery.trim();
  const activeRoot = workspaces.current ?? info.workspaceRoot ?? '';
  const activeProjectRows = useMemo(
    () => [...ungroupedSessions, ...groupedSessions.flatMap(([, items]) => items)],
    [ungroupedSessions, groupedSessions],
  );
  const visibleProjects = useMemo(
    () => projectRoots.filter((root) => projectMatches(root, root === activeRoot ? activeProjectRows : projSessions[root]?.rows ?? [], query)),
    [projectRoots, activeRoot, activeProjectRows, projSessions, query],
  );
  const startProjectDrag = (e: React.DragEvent<HTMLDivElement>, root: string): void => {
    setDraggingProject(root);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', root);
  };
  const overProject = (e: React.DragEvent<HTMLDivElement>, root: string): void => {
    const dragged = draggingProject || e.dataTransfer.getData('text/plain');
    if (dragged && dragged !== root) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTargetProject !== root) setDropTargetProject(root);
    }
  };
  const dropProject = (e: React.DragEvent<HTMLDivElement>, target: string): void => {
    e.preventDefault();
    const dragged = e.dataTransfer.getData('text/plain') || draggingProject;
    setDraggingProject(null);
    setDropTargetProject(null);
    if (dragged && dragged !== target) reorderProject(dragged, target);
  };
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
      </div>
      <div className="rail-card">
        {/* Workspace mode switcher — Chat · Track · Code over the same workspace. */}
        <div className="mode-switch" role="tablist" aria-label="Workspace mode">
          {([['chat', 'bubble', 'Chat'], ['code', 'code', 'Code'], ['track', 'tasks', 'Track']] as const).map(([m, icon, label]) => (
            <button key={m} role="tab" aria-selected={p.mode === m} className={`mode-seg${p.mode === m ? ' active' : ''}`}
              onClick={() => p.setMode(m)} title={`${label} mode`}>
              <Icon name={icon} size={13} /><span>{label}</span>
            </button>
          ))}
        </div>
        <div className="rail-actions">
          <button className="rail-action primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}><Icon name="plus" size={13} />New chat</button>
        </div>
        <div className="projects-head">
          <span>Projects</span>
          <span className="projects-head-actions">
            <button className={`icon-btn${projectSearchOpen ? ' active' : ''}`} title="Filter projects and chats"
              onClick={() => setProjectSearchOpen((open) => !open)}><Icon name="search" size={12} /></button>
            <button className="icon-btn" title={`Sort chats: ${recentsSort}`} onClick={() => setRecentsSort((s) => (s === 'recent' ? 'alpha' : 'recent'))}><Icon name="sort" size={12} /></button>
          </span>
        </div>
        {projectSearchOpen ? (
          <div className="project-filter">
            <Icon name="search" size={12} />
            <input aria-label="Filter projects and chats" value={projectQuery} placeholder="Filter projects or chats"
              onChange={(e) => setProjectQuery(e.target.value)} />
            {query ? (
              <button className="icon-btn project-filter-clear" aria-label="Clear project filter" onClick={() => setProjectQuery('')}>
                <Icon name="close" size={10} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="projects-scroll">
          {visibleProjects.map((w) => {
            const active = w === activeRoot;
            const open = active ? recentsOpen : expandedProjects.includes(w);
            const state = projSessions[w];
            const rows = filterProjectSessions(state?.rows ?? [], query);
            const visibleCount = projectVisibleCounts[w] ?? PROJECT_SESSION_BASE;
            const visibleRows = visibleOtherProjectSessions(state?.rows ?? [], query, visibleCount);
            const projectName = w.split('/').pop() ?? w;
            return (
              <div key={w} className={`project-block${draggingProject === w ? ' dragging' : ''}`}
                draggable
                onDragStart={(e) => startProjectDrag(e, w)}
                onDragOver={(e) => overProject(e, w)}
                onDrop={(e) => dropProject(e, w)}
                onDragLeave={() => setDropTargetProject((root) => root === w ? null : root)}
                onDragEnd={() => { setDraggingProject(null); setDropTargetProject(null); }}>
                <div className={`project-row project-row-composite${active ? ' active' : ''}${dropTargetProject === w ? ' drop-target' : ''}`}
                  title={runningWs.has(w) ? `${w} — running in the background` : w}>
                  <button className="project-row-main" onClick={() => active ? setRecentsOpen((o) => !o) : toggleProject(w)}
                    aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${projectName}`}>
                    <Icon name={open ? 'folder-open' : 'folder'} size={15} />
                    <span>{projectName}</span>
                    <span className="project-meta">
                      {active && activeReviewBadge ? (
                        <span className={`review-badge rb-${activeReviewBadge}`} title={`Review: ${activeReviewBadge.replace('-', ' ')}`}>
                          {activeReviewBadge === 'blocked' ? '⚠' : activeReviewBadge === 'passed' ? '✓' : activeReviewBadge === 'stale' ? '↻' : activeReviewBadge === 'reviewing' ? '…' : '○'}
                        </span>
                      ) : null}
                      {active && prInfo ? (
                        <span className={`pr-chip ${prInfo.state.toLowerCase()}`}
                          title={`#${prInfo.number} · ${prInfo.state.charAt(0)}${prInfo.state.slice(1).toLowerCase()}${prInfo.title ? ` — ${prInfo.title}` : ''}`}>
                          <Icon name="merge" size={12} />
                        </span>
                      ) : null}
                      {!active && state?.loading ? <span className="spinner sm" title="Loading project chats" /> : null}
                      {(() => {
                        const runCount = workspaceRunCount?.get(w) ?? 0;
                        const running = runningWs.has(w) || runCount > 0;
                        if (!running) return null;
                        return (
                          <span className="ws-running" title={runCount > 0 ? `${runCount} task${runCount === 1 ? '' : 's'} running in the background` : 'Running in the background'}>
                            <span className="ws-running-dot" />
                            {!active && runCount > 0 ? <span className="ws-running-count">{runCount}</span> : null}
                          </span>
                        );
                      })()}
                      {!active && state?.rows.length ? <span className="project-count">{state.rows.length}</span> : null}
                      <Icon name={open ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
                    </span>
                  </button>
                  {active ? (
                    <span className="project-drag-handle" title="Drag to reorder"><Icon name="sort" size={12} /></span>
                  ) : (
                    <button className="icon-btn project-open" aria-label={`Open ${projectName}`} title="Open this project here"
                      onClick={(e) => { e.stopPropagation(); openProject(w); }}>
                      <Icon name="arrow-right" size={12} />
                    </button>
                  )}
                </div>
                {active ? (
                  <div className="project-sessions">
                    {/* DESK-5w/6m — chats with per-chat menu; background tasks
                        live in the Background tasks/Dashboard surfaces. */}
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
                ) : open ? (
                  <div className="project-sessions">
                    {state?.error ? <div className="proj-empty error">{state.error}</div> : null}
                    {state === undefined || (state.loading && state.rows.length === 0) ? <div className="proj-empty"><span className="spinner sm" /> Loading chats…</div>
                      : rows.length === 0 ? <div className="proj-empty">{query ? 'No matching chats' : 'No chats yet'}</div>
                      : visibleRows.map((s) => (
                        // WS-UX — parked-project chats get the same ⋮ menu as active
                        // ones; it acts on this workspace (root=w) without switching.
                        <div key={s.sessionKey} className="session-wrap"
                          onContextMenu={(e) => openSessionMenu(e, s.sessionKey, { row: s, root: w })}>
                          {renamingKey === s.sessionKey ? (
                            <input className="session-rename" autoFocus value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingKey(null); }}
                              onBlur={commitRename} />
                          ) : (
                            <>
                              <button className="project-session" title={`${s.sessionKey} — opens ${w.split('/').pop()}`}
                                onClick={() => openProject(w, s.sessionKey)}>
                                <SessionStatus s={s} working={runningSessions.includes(s.sessionKey)} />
                                <span className="session-title">{s.firstUserMessage || s.sessionKey}</span>
                                {s.modifiedAt ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
                              </button>
                              <button className="session-menu-btn icon-btn" aria-label="Chat options" onClick={(e) => openSessionMenu(e, s.sessionKey, { row: s, root: w })}><Icon name="dots" size={13} /></button>
                            </>
                          )}
                        </div>
                      ))}
                    {rows.length > 0 && shouldShowProjectToggle(rows.length, visibleRows.length) ? (
                      <button className="show-more" onClick={() => setProjectVisibleCounts((counts) => ({
                        ...counts,
                        [w]: nextProjectVisibleCount(visibleCount, rows.length),
                      }))}>
                        {projectMoreLabel(rows.length, visibleRows.length)}
                      </button>
                    ) : null}
                    {state?.truncated ? <div className="proj-empty subtle">Showing newest {state.rows.length} chats</div> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {query && visibleProjects.length === 0 ? <div className="proj-empty">No matching projects</div> : null}
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
