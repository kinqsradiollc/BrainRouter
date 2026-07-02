/**
 * Track view — shared helpers + small reusable components (filter chip, compose
 * box, card + card kebab menu, saved-views menu). Split out of TrackView.tsx
 * byte-for-byte; no behavior change.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TrackProject, WorkItem, SavedView } from '@kinqs/brainrouter-types';
import { Icon } from '../../icons.js';
import { TYPE_ICON } from './types.js';

/** True when the search text looks like a JQL query (has an operator/keyword). */
export const looksLikeQuery = (s: string): boolean => /[=~<>]|(\s(and|or|in)\s)/i.test(s);

export const fmtDate = (d?: string): string => (d ? new Date(d).toLocaleDateString() : '—');

// Track dates are conceptually plain calendar dates. They're stored as ISO
// strings, but a UTC-midnight value (e.g. a deadline the agent set as
// "2026-07-01") parsed via `new Date()` in a timezone behind UTC lands on the
// PREVIOUS day — so an item due today would show on yesterday's cell. Read the
// Y/M/D straight off the ISO date portion so an item always sits on the day it
// names, regardless of the viewer's timezone. Returns a local Date at that day.
export const isoToLocalDate = (iso: string): Date => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

export function FilterChip({ label, value, options, onPick }: { label: string; value?: string; options: string[]; onPick: (v: string | undefined) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <span className="track-fchip-wrap">
      <button className={`track-fchip${value ? ' active' : ''}`} onClick={() => setOpen((o) => !o)}>{label}{value ? `: ${value}` : ''} <Icon name="chev-down" size={10} /></button>
      {open ? (
        <div className="track-fmenu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => { onPick(undefined); setOpen(false); }}>Any</button>
          {options.map((o) => <button key={o} className={value === o ? 'active' : ''} onClick={() => { onPick(o); setOpen(false); }}>{o}</button>)}
        </div>
      ) : null}
    </span>
  );
}

export function Compose({ draft, setDraft, onAdd, onCancel }: { draft: string; setDraft: (s: string) => void; onAdd: () => void; onCancel: () => void }): React.ReactElement {
  return (
    <div className="track-compose">
      <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What needs doing?"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAdd(); } if (e.key === 'Escape') onCancel(); }} />
      <div className="track-compose-actions"><button className="track-compose-add" onClick={onAdd}>Add</button><button className="track-compose-cancel" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

/**
 * The per-card "…" kebab menu. It's a real button (portaled menu on click) —
 * NOT a drag handle — so clicking opens actions while dragging still works from
 * the card body. `stopPropagation` keeps a click off the card's open-detail
 * handler, and `onMouseDown`/`draggable=false` keep it from starting a drag.
 */
export function CardMenu({ item, states, onOpen, onTransition }: { item: WorkItem; states: TrackProject['workflowStates']; onOpen: () => void; onTransition: (status: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; bottom: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const el = ref.current;
    if (el) { const r = el.getBoundingClientRect(); setRect({ left: r.left, top: r.top, bottom: r.bottom }); }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest?.('.track-card-menu')) setOpen(false); };
    const close = (): void => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);
  const width = 190;
  const flipUp = rect ? (window.innerHeight - rect.bottom) < 280 && rect.top > (window.innerHeight - rect.bottom) : false;
  return (
    <>
      <button type="button" ref={ref} className="track-card-grip" title="More actions" draggable={false}
        onClick={toggle} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => e.preventDefault()}>
        <Icon name="dots" size={13} />
      </button>
      {open && rect ? createPortal(
        <div className="track-card-menu" style={{ position: 'fixed', left: Math.min(rect.left, window.innerWidth - width - 8), width, ...(flipUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) }}>
          <button type="button" className="track-card-menu-item" onClick={(e) => { e.stopPropagation(); onOpen(); setOpen(false); }}>Open details</button>
          <div className="track-card-menu-sep" />
          <div className="track-card-menu-head">Move to</div>
          {states.map((s) => (
            <button type="button" key={s.id} className={`track-card-menu-item${s.id === item.status ? ' active' : ''}`}
              onClick={(e) => { e.stopPropagation(); if (s.id !== item.status) onTransition(s.id); setOpen(false); }}>
              <span className={`track-cat track-cat-${s.category}`} /><span>{s.name}</span>
            </button>
          ))}
        </div>, document.body) : null}
    </>
  );
}

/** Header "Views" control — apply a saved filter+layout preset, save the current one, or delete. */
export function ViewsMenu({ views, onApply, onSave, onDelete }: { views: SavedView[]; onApply: (v: SavedView) => void; onSave: (name: string) => void; onDelete: (id: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ bottom: number; right: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLButtonElement>(null);
  const toggle = (): void => { const el = ref.current; if (el) { const r = el.getBoundingClientRect(); setRect({ bottom: r.bottom, right: r.right }); } setOpen((o) => !o); setSaving(false); };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest?.('.track-views-menu')) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const submit = (): void => { const n = name.trim(); if (n) { onSave(n); setName(''); setSaving(false); setOpen(false); } };
  const width = 250;
  return (
    <div className="track-views">
      <button type="button" ref={ref} className="track-views-btn" onClick={toggle}>
        <Icon name="panels" size={12} /> Views{views.length ? <span className="track-views-count">{views.length}</span> : null} <Icon name="chev-down" size={10} />
      </button>
      {open && rect ? createPortal(
        <div className="track-views-menu" style={{ position: 'fixed', top: rect.bottom + 5, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), width }}>
          <div className="track-views-head">Saved views</div>
          {views.length === 0 ? <div className="track-views-empty">None yet — save the current filter + layout.</div>
            : views.map((v) => (
              <div key={v.id} className="track-views-item">
                <button type="button" className="track-views-apply" onClick={() => { onApply(v); setOpen(false); }}>
                  <span className="track-views-name">{v.name}</span><span className="track-views-layout">{v.layout}</span>
                </button>
                <button type="button" className="track-views-del" title="Delete view" onClick={() => onDelete(v.id)}>×</button>
              </div>
            ))}
          <div className="track-views-sep" />
          {saving ? (
            <div className="track-views-save">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="View name"
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setSaving(false); }} />
              <button type="button" onClick={submit}>Save</button>
            </div>
          ) : (
            <button type="button" className="track-views-add" onClick={() => setSaving(true)}>＋ Save current view</button>
          )}
        </div>, document.body) : null}
    </div>
  );
}

export function Card({ item, states, onOpen, onTransition, onDragStart, onDragEnd, dragging, labelColors }: { item: WorkItem; states: TrackProject['workflowStates']; onOpen: () => void; onTransition: (status: string) => void; onDragStart: () => void; onDragEnd: () => void; dragging: boolean; labelColors?: Map<string, string> }): React.ReactElement {
  return (
    <div className={`track-card${dragging ? ' dragging' : ''}`} onClick={onOpen} draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.key); onDragStart(); }}
      onDragEnd={onDragEnd}>
      <div className="track-card-top">
        <span className={`track-type track-type-${item.type}`}><Icon name={TYPE_ICON[item.type]} size={11} /></span>
        <span className="track-card-key mono">{item.key}</span>
        <span className={`track-pri pri-${item.priority}`} title={`Priority: ${item.priority}`} />
        <CardMenu item={item} states={states} onOpen={onOpen} onTransition={onTransition} />
      </div>
      <div className="track-card-title">{item.title}</div>
      {(item.assignees.length || item.labels.length) ? (
        <div className="track-card-foot">
          {item.labels.slice(0, 2).map((l) => <span key={l} className="track-label" style={labelColors?.get(l.toLowerCase()) ? { borderColor: labelColors.get(l.toLowerCase()), color: labelColors.get(l.toLowerCase()) } : undefined}>{l}</span>)}
          {item.assignees.slice(0, 2).map((a) => <span key={a} className="track-asn" title={a}>{a.slice(0, 2).toUpperCase()}</span>)}
          {item.assignees.length > 2 ? <span className="track-asn track-asn-more" title={item.assignees.join(', ')}>+{item.assignees.length - 2}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
