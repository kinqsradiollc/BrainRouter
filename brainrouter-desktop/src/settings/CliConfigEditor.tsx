/** §control-consistency — a PROPER editor for the raw `cli.*` config block: each
 *  knob is a typed row (toggle / number / text) with add + remove, instead of a
 *  hand-edited JSON blob. Saves the whole block via the existing set-cli-json. */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import { KnobValue } from './controls.js';
import { DEDICATED_KNOBS, INTERNAL_KNOBS } from './types.js';

export function CliConfigEditor({ cli, onSave }: { cli: Record<string, unknown>; onSave: (next: Record<string, unknown>) => void }): React.ReactElement {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...cli }));
  React.useEffect(() => setDraft({ ...cli }), [cli]);
  const [newKey, setNewKey] = useState('');
  // WS11 — hide dedicated-editor + internal knobs from the raw list. They stay in
  // `draft` so saving never drops them; they're just not hand-edited as raw JSON here.
  const keys = Object.keys(draft).filter((k) => !DEDICATED_KNOBS.has(k) && !INTERNAL_KNOBS.has(k)).sort();
  const dirty = JSON.stringify(draft) !== JSON.stringify(cli);
  const setVal = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));
  const remove = (k: string): void => setDraft((d) => { const n = { ...d }; delete n[k]; return n; });
  const addKey = (): void => { const k = newKey.trim(); if (!k || k in draft) return; setDraft((d) => ({ ...d, [k]: '' })); setNewKey(''); };
  return (
    <div className="cli-knobs">
      {keys.length === 0 ? <div className="set-desc cli-knob-empty">No custom <code>cli</code> knobs set — add one below or use the dedicated controls in <b>Advanced</b>.</div> : null}
      {keys.map((k) => (
        <div key={k} className="cli-knob-row">
          <code className="cli-knob-key" title={k}>{k}</code>
          <div className="cli-knob-val"><KnobValue value={draft[k]} onChange={(v) => setVal(k, v)} /></div>
          <button className="icon-btn cli-knob-x" title={`Remove ${k}`} onClick={() => remove(k)}><Icon name="x" size={13} /></button>
        </div>
      ))}
      <div className="cli-knob-add">
        <input className="ctl" placeholder="add a knob key, e.g. maxToolLoops" value={newKey}
          onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addKey(); }} />
        <button className="btn" onClick={addKey} disabled={!newKey.trim()}>Add knob</button>
      </div>
      <div className="set-actions">
        <button className="btn" disabled={!dirty} onClick={() => setDraft({ ...cli })}>Reset</button>
        <button className="btn primary" disabled={!dirty} onClick={() => onSave(draft)}>Save changes</button>
      </div>
    </div>
  );
}
