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
import { MANUAL_PANEL_DEFS, type PanelId } from './panelCatalog.js';
export { MANUAL_PANEL_DEFS, PANEL_DEFS, type PanelId } from './panelCatalog.js';

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
