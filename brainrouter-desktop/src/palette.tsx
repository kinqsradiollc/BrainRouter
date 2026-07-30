/**
 * DESK-4c — command surfaces: the ⌘K palette overlay and the composer "/"
 * popup share one list component. Every CLI slash command appears (live
 * catalog from the host); badges show how each lands on desktop.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { wireBadge, type DeskCommand } from './lib/commands/commands.js';

export function CommandList({ commands, filter, selected, onPick, onHover }: {
  commands: DeskCommand[];
  filter: string;
  selected: number;
  onPick: (c: DeskCommand) => void;
  onHover?: (i: number) => void;
}): React.ReactElement {
  const shown = useMemo(() => filterCommands(commands, filter), [commands, filter]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div className="pal-list" ref={listRef}>
      {shown.length === 0 ? <div className="empty">No matching commands.</div> : shown.map((c, i) => (
        <button key={c.base + c.category} className={`pal-item${i === selected ? ' sel' : ''}`}
          onMouseEnter={() => onHover?.(i)} onClick={() => onPick(c)}>
          <span className="pal-cmd">{c.base}</span>
          <span className="pal-desc">{c.desc || c.category}</span>
          <span className={`badge ${wireBadge(c.wire)}`}>{wireBadge(c.wire)}</span>
        </button>
      ))}
    </div>
  );
}

export function filterCommands(commands: DeskCommand[], filter: string): DeskCommand[] {
  // The catalog carries one entry per SUBCOMMAND (/agents, /agents tree,
  // /agents why … all share base "/agents"). The palette dispatches by base
  // and shows the name only, so collapse to ONE row per base — the first
  // occurrence, which the catalog lists as the primary form. Settings →
  // Commands still lists every subcommand; only these popups dedup.
  const byBase = new Map<string, DeskCommand>();
  for (const c of commands) if (!byBase.has(c.base)) byBase.set(c.base, c);
  const unique = [...byBase.values()];
  const q = filter.trim().toLowerCase().replace(/^\//, '');
  if (!q) return unique.slice(0, 60);
  const scored = unique
    .map((c) => {
      const name = c.base.slice(1);
      const hay = `${name} ${c.desc}`.toLowerCase();
      const score = name === q ? 0 : name.startsWith(q) ? 1 : hay.includes(q) ? 2 : -1;
      return { c, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, 60).map((x) => x.c);
}

/**
 * Composer "/" popup — names-only list with a side pane describing the
 * highlighted command (the pattern the reference app uses).
 */
export function SlashPopup({ commands, filter, selected, onPick, onHover }: {
  commands: DeskCommand[];
  filter: string;
  selected: number;
  onPick: (c: DeskCommand) => void;
  onHover: (i: number) => void;
}): React.ReactElement {
  const shown = useMemo(() => filterCommands(commands, filter), [commands, filter]);
  const sel = shown[Math.min(selected, shown.length - 1)];
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div className="slash-split">
      <div className="pal-list" ref={listRef}>
        {shown.length === 0 ? <div className="empty">No matching commands.</div> : shown.map((c, i) => (
          <button key={c.base + c.category} className={`pal-item${i === selected ? ' sel' : ''}`}
            onMouseEnter={() => onHover(i)} onClick={() => onPick(c)}>
            <span className="pal-cmd">{c.base.slice(1)}</span>
          </button>
        ))}
      </div>
      {sel ? (
        <div className="slash-desc">
          <span className="slash-desc-cmd">{sel.cmd}</span>
          <p>{sel.desc || sel.category}</p>
          <span className={`badge ${wireBadge(sel.wire)}`}>{wireBadge(sel.wire)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function CommandPalette({ open, commands, onClose, onRun }: {
  open: boolean;
  commands: DeskCommand[];
  onClose: () => void;
  onRun: (c: DeskCommand) => void;
}): React.ReactElement | null {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => { if (open) { setQ(''); setSel(0); } }, [open]);
  if (!open) return null;
  const shown = filterCommands(commands, q);
  const pick = (c: DeskCommand) => { onClose(); onRun(c); };
  return (
    <>
      <div className="palette-overlay" onClick={onClose} />
      <div className="palette" onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
        if (e.key === 'Enter' && shown[sel]) pick(shown[sel]);
      }}>
        <input autoFocus placeholder="Search commands…  (every CLI / command lives here)"
          value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} />
        <CommandList commands={commands} filter={q} selected={sel} onPick={pick} onHover={setSel} />
      </div>
    </>
  );
}
