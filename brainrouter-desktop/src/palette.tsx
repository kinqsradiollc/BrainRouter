/**
 * DESK-4c — command surfaces: the ⌘K palette overlay and the composer "/"
 * popup share one list component. Every CLI slash command appears (live
 * catalog from the host); badges show how each lands on desktop.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { wireBadge, type DeskCommand } from './commands.js';

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
  const q = filter.trim().toLowerCase().replace(/^\//, '');
  if (!q) return commands.slice(0, 60);
  const scored = commands
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
