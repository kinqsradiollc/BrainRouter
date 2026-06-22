/**
 * T4 — the export-session modal and the per-chat ⋮ context menu (Open PR /
 * Open in / Pin / Mark completed / Rename / Fork / Move to group / Archive /
 * Delete). Extracted verbatim from App.tsx; the App owns the session-menu
 * state and all the action handlers, passed through as props.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import type { PopId, SessionRow } from '../types.js';

export interface ExportAndMenuDialogsProps {
  pop: PopId;
  setPop: Dispatch<SetStateAction<PopId>>;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  sessionMenu: { key: string; x: number; y: number; row?: SessionRow; root?: string } | null;
  sessions: SessionRow[];
  closeSessionMenu: () => void;
  openExternal: (what: string) => void;
  togglePin: (s: SessionRow, root?: string) => void;
  toggleComplete: (s: SessionRow, root?: string) => void;
  startRename: (s: SessionRow, root?: string) => void;
  forkSessionAction: (key: string, upToTs?: number, root?: string) => void;
  moveToGroup: (key: string, group: string | null, root?: string) => void;
  sessionGroups: string[];
  toggleArchive: (s: SessionRow, root?: string) => void;
  deleteSessionAction: (key: string, root?: string) => void;
}

export function ExportAndMenuDialogs(p: ExportAndMenuDialogsProps): React.ReactElement {
  const { pop, setPop, q, sessionMenu, sessions, closeSessionMenu, openExternal, togglePin, toggleComplete, startRename, forkSessionAction, moveToGroup, sessionGroups, toggleArchive, deleteSessionAction } = p;
  return (
    <>
      {pop === 'export' ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setPop(''); }}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-title">Export session</div>
            <div className="set-desc" style={{ marginBottom: 12 }}>Save this session's transcript to a file — same as /export-chat in the CLI.</div>
            <div className="dialog-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="approve" onClick={() => { q('q-export', 'export-chat', { format: 'md' }); setPop(''); }}>Markdown</button>
              <button className="deny" onClick={() => { q('q-export', 'export-chat', { format: 'json' }); setPop(''); }}>JSON</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* DESK-6m — per-chat ⋮ context menu (Open PR / Open in / Pin / Mark
          completed / Rename / Fork / Move to group / Archive / Delete). */}
      {sessionMenu ? (() => {
        // WS-UX — `row` is supplied for sessions in a NON-active workspace (parked
        // project) that aren't in the active `sessions` list; `root` routes the
        // write to that workspace. When parked, hide the active-workspace-only
        // items (Open PR / Open in / inline Rename).
        const s = sessionMenu.row ?? sessions.find((x) => x.sessionKey === sessionMenu.key);
        if (!s) return null;
        const root = sessionMenu.root;
        return (
          <>
            <div className="menu-scrim" onClick={closeSessionMenu} onContextMenu={(e) => { e.preventDefault(); closeSessionMenu(); }} />
            <div className="ctx-menu" style={{ left: sessionMenu.x, top: sessionMenu.y }} onClick={(e) => e.stopPropagation()}>
              {!root ? (
                <>
                  <button className="ctx-item" onClick={() => openExternal('pr')}><Icon name="merge" size={13} /><span>Open PR</span><span className="ctx-key">G</span></button>
                  <div className="ctx-sub">
                    <button className="ctx-item"><Icon name="external" size={13} /><span>Open in</span><span className="ctx-key"><Icon name="chev-right" size={10} /></span></button>
                    <div className="ctx-flyout">
                      <button className="ctx-item" onClick={() => openExternal('editor')}><span>Editor</span></button>
                      <button className="ctx-item" onClick={() => openExternal('finder')}><span>Finder</span></button>
                      <button className="ctx-item" onClick={() => openExternal('terminal')}><span>Terminal</span></button>
                    </div>
                  </div>
                  <div className="ctx-sep" />
                </>
              ) : null}
              <button className="ctx-item" onClick={() => togglePin(s, root)}><Icon name="pin" size={13} /><span>{s.pinned ? 'Unpin' : 'Pin'}</span><span className="ctx-key">P</span></button>
              <button className="ctx-item" onClick={() => toggleComplete(s, root)}><Icon name="check-circle" size={13} /><span>{s.status === 'completed' ? 'Mark as active' : 'Mark as completed'}</span><span className="ctx-key">U</span></button>
              <button className="ctx-item" onClick={() => startRename(s, root)}><Icon name="edit" size={13} /><span>Rename</span><span className="ctx-key">R</span></button>
              <button className="ctx-item" onClick={() => forkSessionAction(s.sessionKey, undefined, root)}><Icon name="fork" size={13} /><span>Fork</span><span className="ctx-key">F</span></button>
              <div className="ctx-sub">
                <button className="ctx-item"><Icon name="folder" size={13} /><span>Move to group</span><span className="ctx-key"><Icon name="chev-right" size={10} /></span></button>
                <div className="ctx-flyout">
                  {sessionGroups.map((g) => (
                    <button key={g} className="ctx-item" onClick={() => moveToGroup(s.sessionKey, g, root)}><span>{g}</span>{s.group === g ? <span className="ctx-key">✓</span> : null}</button>
                  ))}
                  {s.group ? <button className="ctx-item" onClick={() => moveToGroup(s.sessionKey, null, root)}><span>Ungroup</span></button> : null}
                  <button className="ctx-item" onClick={() => { const g = window.prompt('New group name'); if (g && g.trim()) moveToGroup(s.sessionKey, g.trim(), root); }}><span>New group…</span><span className="ctx-key">1</span></button>
                </div>
              </div>
              <div className="ctx-sep" />
              <button className="ctx-item" onClick={() => toggleArchive(s, root)}><Icon name="archive" size={13} /><span>{s.archived ? 'Unarchive' : 'Archive'}</span><span className="ctx-key">A</span></button>
              <button className="ctx-item danger" onClick={() => deleteSessionAction(s.sessionKey, root)}><Icon name="trash" size={13} /><span>Delete</span><span className="ctx-key">D</span></button>
            </div>
          </>
        );
      })() : null}
    </>
  );
}
