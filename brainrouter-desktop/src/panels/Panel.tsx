/**
 * The panel system: togglable, closeable panels that open as full-height
 * resizable window columns right of the chat (File · Files · Diff · Terminal ·
 * Tool calls · Background tasks · Plan · Context · Search). Each panel is a
 * dumb component over App-owned state; the App owns column widths and the
 * drag-to-resize grips. This module holds the panel id catalog and the chrome
 * (the framing <Panel> and the views <PanelPicker> menu).
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';

export type PanelId = 'context' | 'files' | 'file' | 'editor' | 'diff' | 'terminal' | 'tools' | 'tasks' | 'dashboard' | 'plan' | 'search' | 'schedule' | 'worktrees' | 'review' | 'requirements' | 'annotations' | 'artifacts' | 'ci' | 'atlas' | 'workflows' | 'write';

export const PANEL_DEFS: Array<{ id: PanelId; title: string; icon: string }> = [
  { id: 'context', title: 'Context', icon: 'layout-right' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'file', title: 'File', icon: 'file' },
  { id: 'editor', title: 'Editor', icon: 'file' },
  { id: 'diff', title: 'Changes', icon: 'diff' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal' },
  { id: 'tools', title: 'Tool calls', icon: 'bolt' },
  { id: 'tasks', title: 'Background tasks', icon: 'tasks' },
  { id: 'dashboard', title: 'Dashboard', icon: 'tasks' },
  { id: 'plan', title: 'Plan', icon: 'plan' },
  { id: 'search', title: 'Search session', icon: 'search' },
  { id: 'schedule', title: 'Schedules', icon: 'clock' },
  { id: 'worktrees', title: 'Worktrees', icon: 'branch' },
  { id: 'review', title: 'Review', icon: 'review' },
  { id: 'requirements', title: 'Requirements', icon: 'tasks' },
  { id: 'annotations', title: 'Annotations', icon: 'review' },
  { id: 'artifacts', title: 'Artifacts', icon: 'file' },
  { id: 'ci', title: 'PR / Checks', icon: 'check-circle' },
  { id: 'atlas', title: 'Atlas', icon: 'atlas' },
  { id: 'workflows', title: 'Workflows', icon: 'bolt' },
  { id: 'write', title: 'Write', icon: 'file' },
];

const HIDDEN_MANUAL_PANEL_IDS = new Set<PanelId>([
  // The read-only file viewer is legacy/internal; the Monaco editor owns file
  // viewing and editing in user-facing menus.
  'file',
]);

export const MANUAL_PANEL_DEFS = PANEL_DEFS.filter((d) => !HIDDEN_MANUAL_PANEL_IDS.has(d.id));

export function Panel({ title, onClose, children, actions }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">{title}</span>
        <span className="panel-actions">{actions}<button className="icon-btn" title="Close" onClick={onClose}><Icon name="close" size={12} /></button></span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function PanelPicker({ open, onToggle }: {
  open: PanelId[];
  onToggle: (id: PanelId) => void;
}): React.ReactElement {
  const [menu, setMenu] = useState(false);
  const SHORTCUTS: Partial<Record<PanelId, string>> = { diff: '⇧⌘D', terminal: '⌃`', files: '⇧⌘F' };
  return (
    <div className="picker">
      <button className="chip chip-ic" onClick={() => setMenu((m) => !m)} title="Views"><Icon name="layout-right" size={13} /> Views</button>
      {menu ? (
        <>
          <div className="picker-backdrop" onClick={() => setMenu(false)} />
          <div className="picker-menu">
            {MANUAL_PANEL_DEFS.map((d) => (
              <button key={d.id} className="picker-item" onClick={() => onToggle(d.id)}>
                <span className="picker-check">{open.includes(d.id) ? '✓' : ''}</span>
                <span className="picker-icon"><Icon name={d.icon} size={14} /></span>{d.title}
                {SHORTCUTS[d.id] ? <span className="picker-hint">{SHORTCUTS[d.id]}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
