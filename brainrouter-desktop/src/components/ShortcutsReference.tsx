/**
 * §shortcuts — the keyboard-shortcut reference shown in Advanced settings.
 * Reads the central registry and formats every combo for the detected OS, with
 * a search box and per-area grouping. (B2 will layer rebinding onto this.)
 */
import React, { useState } from 'react';
import { SHORTCUTS, SHORTCUT_AREAS, usePlatform } from '../lib/shortcuts/shortcuts.js';

export function ShortcutsReference(): React.ReactElement {
  const { os, fmt } = usePlatform();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? SHORTCUTS.filter((s) => s.action.toLowerCase().includes(q) || fmt(s.combo).toLowerCase().includes(q))
    : SHORTCUTS;
  const osLabel = os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux';
  return (
    <>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        Shown for <b>{osLabel}</b> (auto-detected) — modifier keys map to your keyboard.
      </div>
      <input className="shortcut-search" placeholder="Search shortcuts…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="shortcut-table">
        {SHORTCUT_AREAS.map((area) => {
          const rows = shown.filter((s) => s.area === area);
          if (!rows.length) return null;
          return (
            <div key={area} className="shortcut-group">
              <div className="shortcut-group-title">{area}</div>
              {rows.map((s) => (
                <div key={s.id} className="shortcut-row">
                  <span className="shortcut-action">{s.action}</span>
                  <kbd className="shortcut-keys">{fmt(s.combo)}</kbd>
                </div>
              ))}
            </div>
          );
        })}
        {shown.length === 0 ? <div className="set-desc">No shortcuts match “{query}”.</div> : null}
      </div>
    </>
  );
}
