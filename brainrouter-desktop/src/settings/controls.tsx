/**
 * Shared value/label controls for the Settings modal rows — typed knob editors,
 * toggle, and the portal-free ChoiceControl / ComboInput pickers. Extracted from
 * settings.tsx byte-for-byte so every section renders identical controls.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import type { ChoiceOption, WireFormatOverride } from './types.js';

export function Row({ title, desc, children }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="set-row">
      <div className="grow">
        <div className="set-title">{title}</div>
        {desc ? <div className="set-desc">{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return <button className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />;
}

/** A typed value control for one cli knob: boolean → toggle, number → number
 *  input, object/array → per-key JSON, everything else → text. */
export function KnobValue({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): React.ReactElement {
  if (typeof value === 'boolean') return <Toggle on={value} onChange={onChange} />;
  if (typeof value === 'number') {
    return <input className="ctl" type="number" style={{ width: 150 }} value={Number.isFinite(value) ? String(value) : ''}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
  }
  if (value !== null && typeof value === 'object') {
    return <input className="ctl cli-knob-json" defaultValue={JSON.stringify(value)} spellCheck={false}
      onBlur={(e) => { try { onChange(JSON.parse(e.target.value)); } catch { /* leave prior value */ } }} />;
  }
  return <input className="ctl" style={{ minWidth: 200 }} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} />;
}

/** §settings-completeness — a number knob that commits on blur/Enter. Empty =
 * clears the knob (reverts to the default). */
export function KnobNumber({ value, onSave, placeholder }: { value: unknown; onSave: (v: number | null) => void; placeholder?: string }): React.ReactElement {
  const cur = typeof value === 'number' ? String(value) : '';
  const [v, setV] = useState(cur);
  React.useEffect(() => setV(cur), [cur]);
  const commit = (): void => { const t = v.trim(); if (t === '') { onSave(null); return; } const n = Number(t); if (Number.isFinite(n)) onSave(n); };
  return <input className="ctl" type="number" style={{ width: 140 }} value={v} placeholder={placeholder ?? 'default'}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function KnobText({ value, onSave, placeholder }: { value: unknown; onSave: (v: string | null) => void; placeholder?: string }): React.ReactElement {
  const cur = typeof value === 'string' ? value : '';
  const [v, setV] = useState(cur);
  React.useEffect(() => setV(cur), [cur]);
  const commit = (): void => { const t = v.trim(); onSave(t || null); };
  return <input className="ctl mono" style={{ minWidth: 260 }} value={v} placeholder={placeholder ?? ''}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} spellCheck={false} />;
}

export function ChoiceControl({ value, options, onChange, placeholder = 'Select' }: {
  value: string;
  options: ChoiceOption[];
  onChange: (v: string) => void;
  placeholder?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <div className="choice" onBlur={() => window.setTimeout(() => setOpen(false), 120)}>
      <button type="button" className={`ctl choice-btn${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span className={selected ? '' : 'choice-placeholder'}>{selected?.label ?? placeholder}</span>
        <Icon name="chev-down" size={14} />
      </button>
      {open ? (
        <div className="choice-menu">
          {options.map((o) => (
            <button key={o.value} type="button" className={`choice-option${o.value === value ? ' selected' : ''}`} disabled={o.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (!o.disabled) { onChange(o.value); setOpen(false); } }}>
              <span>{o.label}</span>
              {o.detail ? <span className="choice-detail">{o.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }): React.ReactElement {
  return <ChoiceControl value={value} options={options.map((o) => ({ value: o, label: o }))} onChange={onChange} />;
}

/** Per-provider wire-format selector. `default` removes the provider key from
 *  `cli.providerRequestFormat`; the IPC handler shallow-replaces the map. */
export function WireFormatSelect({ value, onChange }: { value: WireFormatOverride | null; onChange: (v: WireFormatOverride | null) => void }): React.ReactElement {
  return (
    <ChoiceControl
      value={value ?? 'default'}
      options={[
        { value: 'default', label: 'Default', detail: 'provider contract' },
        { value: 'chat-completions', label: 'Chat Completions', detail: '/v1/chat/completions' },
        { value: 'responses', label: 'Responses', detail: '/v1/responses' },
      ]}
      onChange={(v) => onChange(v === 'default' ? null : v as WireFormatOverride)}
    />
  );
}

export function ComboInput({ value, options, onChange, placeholder, disabled, style }: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const filtered = (q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, 80);
  return (
    <div className="combo" style={style} onBlur={() => window.setTimeout(() => setOpen(false), 120)}>
      <input className="ctl combo-input" disabled={disabled} value={value} placeholder={placeholder}
        onFocus={() => setOpen(true)} onChange={(e) => { onChange(e.target.value); setOpen(true); }} />
      {open && !disabled && filtered.length > 0 ? (
        <div className="choice-menu combo-menu">
          {filtered.map((o) => (
            <button key={o} type="button" className={`choice-option${o === value ? ' selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(o); setOpen(false); }}>
              <span>{o}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
