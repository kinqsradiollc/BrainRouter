/**
 * The far-left activity bar — icon-only workspace-mode switching (Chat · Code ·
 * Track · Meetings) plus the app-wide workspace/organization switcher.
 *
 * Replaces the four labeled segments that were crammed into the top of the
 * (min 220px) sidebar: modes are now one icon each with a tooltip, and they
 * stay reachable even when the sidebar is collapsed. The bottom hosts the
 * ADR-019 workspace switcher (personal ↔ organizations) that scopes every
 * org-aware surface through WorkspaceOrgProvider.
 */
import React, { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import { useActiveOrg } from '../../lib/orgContext.js';

export type WorkspaceMode = 'chat' | 'track' | 'code' | 'meetings' | 'planner';

const MODES: ReadonlyArray<readonly [WorkspaceMode, string, string]> = [
  ['chat', 'bubble', 'Chat'],
  ['code', 'code', 'Code'],
  ['track', 'tasks', 'Track'],
  ['meetings', 'mic', 'Meetings'],
  // ADR-028 G6 — the planner is a MODE, not a panel: it is user-scoped and
  // spans every project, and panels are bound to one workspace and session.
  ['planner', 'plan', 'Planner'],
];

export interface ActivityBarProps {
  mode: WorkspaceMode;
  setMode: Dispatch<SetStateAction<WorkspaceMode>>;
  railOpen: boolean;
  setRailOpen: Dispatch<SetStateAction<boolean>>;
}

export function ActivityBar({ mode, setMode, railOpen, setRailOpen }: ActivityBarProps): React.ReactElement {
  const { contexts, activeContext, setActiveOrg, refresh } = useActiveOrg();
  const [orgOpen, setOrgOpen] = useState(false);
  const orgRef = useRef<HTMLDivElement | null>(null);

  // Close the workspace popover on outside click / Escape.
  useEffect(() => {
    if (!orgOpen) return;
    const onDown = (e: MouseEvent): void => { if (!orgRef.current?.contains(e.target as Node)) setOrgOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOrgOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [orgOpen]);

  return (
    <nav className="activity-bar" aria-label="Workspace modes">
      <button className="ab-btn" title={railOpen ? 'Hide sidebar' : 'Show sidebar'}
        aria-label={railOpen ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={railOpen}
        onClick={() => setRailOpen((open) => !open)}>
        <Icon name="layout" size={15} />
      </button>
      <div className="ab-modes" role="tablist" aria-label="Workspace mode">
        {MODES.map(([m, icon, label]) => (
          <button key={m} role="tab" data-mode={m} aria-selected={mode === m} aria-label={`${label} mode`}
            className={`ab-btn ab-mode${mode === m ? ' active' : ''}`} title={`${label} mode`}
            onClick={() => setMode(m)}>
            <Icon name={icon} size={16} />
          </button>
        ))}
      </div>
      <div className="ab-spacer" />
      {contexts.length > 0 ? (
        <div className="ab-org" ref={orgRef}>
          <button className={`ab-btn ab-org-btn${orgOpen ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={orgOpen}
            title={activeContext ? `Workspace: ${activeContext.name}${activeContext.isPersonal ? ' · Personal' : ''}` : 'Switch workspace'}
            aria-label="Switch workspace"
            onClick={() => { setOrgOpen((open) => !open); if (!orgOpen) void refresh(); }}>
            <span className="ab-org-avatar">{(activeContext?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          </button>
          {orgOpen ? (
            <div className="ab-org-pop" role="menu" aria-label="Switch workspace">
              <div className="ab-org-head">Workspace</div>
              {contexts.map((context) => (
                <button key={context.orgId} type="button" role="menuitemradio"
                  aria-checked={context.orgId === activeContext?.orgId}
                  className={`ab-org-item${context.orgId === activeContext?.orgId ? ' active' : ''}`}
                  onClick={() => { setActiveOrg(context.orgId); setOrgOpen(false); }}>
                  <span className="ab-org-avatar sm">{context.name.slice(0, 1).toUpperCase()}</span>
                  <span className="ab-org-copy">
                    <strong>{context.name}</strong>
                    <small>{context.isPersonal ? 'Personal workspace' : context.role ?? 'Member'}</small>
                  </span>
                  {context.orgId === activeContext?.orgId ? <span className="ab-org-check">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
