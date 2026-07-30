/**
 * §shortcuts / §5.9 — the keyboard-shortcut surface in Advanced settings, now
 * CUSTOMIZABLE: each combo is click-to-rebind (press the new keys, Esc to
 * cancel), overrides persist to `cli.shortcuts`, within-area collisions are
 * flagged, and a per-row reset restores the default. Formatting + the override
 * resolution come from the shared `lib/shortcuts` registry.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { SHORTCUT_AREAS, usePlatform, captureCombo, resolveShortcutOverrides } from '../../lib/shortcuts/shortcuts.js';
import { hostQuery } from '../../lib/hostQuery.js';

export function ShortcutsReference(): React.ReactElement {
  const { os, fmt } = usePlatform();
  const [query, setQuery] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await hostQuery<{ overrides?: Record<string, string> }>('shortcuts-get');
      if (r?.overrides) setOverrides(r.overrides);
    })();
  }, []);

  const { shortcuts, conflicts } = resolveShortcutOverrides(overrides);
  const conflictIds = new Set(conflicts.flat());

  const rebind = useCallback((id: string, combo: string | null) => {
    setCapturing(null);
    setOverrides((prev) => {
      const next = { ...prev };
      if (combo) next[id] = combo; else delete next[id];
      void hostQuery<{ ok?: boolean; overrides?: Record<string, string> }>('shortcuts-save', { overrides: next })
        .then((r) => { setStatus(r?.ok ? 'Saved.' : 'Save failed.'); if (r?.overrides) setOverrides(r.overrides); });
      return next;
    });
  }, []);

  // While capturing, the next keystroke becomes the new binding (Esc cancels).
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const combo = captureCombo(e, os);
      if (combo) rebind(capturing, combo);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, os, rebind]);

  const q = query.trim().toLowerCase();
  const shown = q ? shortcuts.filter((s) => s.action.toLowerCase().includes(q) || fmt(s.combo).toLowerCase().includes(q)) : shortcuts;
  const osLabel = os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux';
  return (
    <>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        Shown for <b>{osLabel}</b> — click a combo to rebind it, <kbd>Esc</kbd> to cancel. Custom binds save to <code>cli.shortcuts</code>. {status}
      </div>
      <input className="shortcut-search" placeholder="Search shortcuts…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="shortcut-table">
        {SHORTCUT_AREAS.map((area) => {
          const rows = shown.filter((s) => s.area === area);
          if (!rows.length) return null;
          return (
            <div key={area} className="shortcut-group">
              <div className="shortcut-group-title">{area}</div>
              {rows.map((s) => {
                const overridden = !!overrides[s.id];
                return (
                  <div key={s.id} className={`shortcut-row${conflictIds.has(s.id) ? ' conflict' : ''}`}>
                    <span className="shortcut-action">{s.action}{overridden ? <span className="shortcut-custom" title="Customized">•</span> : null}</span>
                    <span className="shortcut-keys-wrap">
                      <button className={`shortcut-keys editable${capturing === s.id ? ' capturing' : ''}`} onClick={() => setCapturing(s.id)} title="Click, then press the new combo">
                        {capturing === s.id ? 'press keys…' : fmt(s.combo)}
                      </button>
                      {overridden ? <button className="shortcut-reset" title="Reset to default" onClick={() => rebind(s.id, null)}>↺</button> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {shown.length === 0 ? <div className="set-desc">No shortcuts match “{query}”.</div> : null}
      </div>
      {conflicts.length ? <div className="shortcut-conflict-note">⚠ {conflicts.length} binding{conflicts.length === 1 ? '' : 's'} collide within an area — the first match wins.</div> : null}
    </>
  );
}
