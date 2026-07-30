/**
 * Track view — Automation rules panel + rule builder form. Split out of
 * TrackView.tsx byte-for-byte; no behavior change.
 */
import React, { useMemo, useState } from 'react';
import type { TrackProject, AutomationRule, AutomationTrigger, AutomationAction, AutomationActionType } from '@kinqs/brainrouter-types';
import { parseTrackQuery } from '../../../lib/track/query.js';
import { Icon } from '../../../icons.js';
import { TrackDropdown } from '../../Dropdown.js';
import type { TrackOps } from '../shared/types.js';

const TRIGGERS: Array<{ id: AutomationTrigger; label: string; hint: string }> = [
  { id: 'created', label: 'When created', hint: 'a new work item is added' },
  { id: 'transitioned', label: 'When moved', hint: 'an item changes status' },
  { id: 'updated', label: 'When edited', hint: 'any field changes' },
];
const ACTION_TYPES: Array<{ id: AutomationActionType; label: string; placeholder: string }> = [
  { id: 'set-status', label: 'Set status', placeholder: 'status id (e.g. in-progress)' },
  { id: 'set-priority', label: 'Set priority', placeholder: 'urgent · high · medium · low · none' },
  { id: 'set-assignee', label: 'Assign to', placeholder: 'name' },
  { id: 'add-label', label: 'Add label', placeholder: 'label' },
  { id: 'comment', label: 'Comment', placeholder: 'comment text' },
];
const actionLabel = (a: AutomationAction): string => `${ACTION_TYPES.find((t) => t.id === a.type)?.label ?? a.type}: ${a.value}`;

export function AutomationView({ automations, states, ops }: { automations: AutomationRule[]; states: TrackProject['workflowStates']; ops: TrackOps }): React.ReactElement {
  const [adding, setAdding] = useState(false);
  return (
    <div className="track-automation">
      <div className="track-section-head">
        Automation rules <span className="track-col-count">{automations.length}</span>
        <button className="track-auto-new" onClick={() => setAdding((a) => !a)}><Icon name={adding ? 'close' : 'plus'} size={12} /> {adding ? 'Cancel' : 'New rule'}</button>
      </div>
      <p className="track-auto-intro">When something happens on this project, run an action automatically — no human in the loop. Conditions use the same query language as the filter bar (e.g. <code>type = bug</code>).</p>
      {adding ? <AutomationForm states={states} onCreate={(input) => { ops.createAutomation(input); setAdding(false); }} onCancel={() => setAdding(false)} /> : null}
      <div className="track-auto-list">
        {automations.map((r) => (
          <div key={r.id} className={`track-auto-row${r.enabled ? '' : ' off'}`}>
            <button className={`track-auto-toggle${r.enabled ? ' on' : ''}`} title={r.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'} onClick={() => ops.updateAutomation(r.id, { enabled: !r.enabled })}>
              <span className="track-auto-knob" />
            </button>
            <div className="track-auto-body">
              <div className="track-auto-name">{r.name}</div>
              <div className="track-auto-flow">
                <span className="track-auto-trigger">{TRIGGERS.find((t) => t.id === r.trigger)?.label ?? r.trigger}</span>
                {r.condition ? <span className="track-auto-cond mono">if {r.condition}</span> : null}
                <Icon name="chev-right" size={11} />
                {r.actions.map((a, i) => <span key={i} className="track-auto-act">{actionLabel(a)}</span>)}
              </div>
            </div>
            <button className="track-auto-del" title="Delete rule" onClick={() => ops.deleteAutomation(r.id)}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        {automations.length === 0 && !adding ? <div className="track-empty">No automation rules yet. Create one to run actions automatically.</div> : null}
      </div>
    </div>
  );
}

function AutomationForm({ states, onCreate, onCancel }: { states: TrackProject['workflowStates']; onCreate: (input: { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }) => void; onCancel: () => void }): React.ReactElement {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<AutomationTrigger>('created');
  const [condition, setCondition] = useState('');
  const [actions, setActions] = useState<AutomationAction[]>([{ type: 'set-priority', value: '' }]);
  const condCheck = useMemo(() => (condition.trim() ? parseTrackQuery(condition.trim()) : null), [condition]);
  const valid = name.trim() && actions.every((a) => a.value.trim()) && (!condCheck || condCheck.ok);

  const setAction = (i: number, patch: Partial<AutomationAction>): void => setActions((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const submit = (): void => {
    if (!valid) return;
    onCreate({ name: name.trim(), trigger, condition: condition.trim() || undefined, actions: actions.map((a) => ({ ...a, value: a.value.trim() })) });
  };

  return (
    <div className="track-auto-form">
      <input className="track-auto-fname" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name (e.g. Bugs start at high priority)" />
      <div className="track-auto-field">
        <label>When</label>
        <TrackDropdown value={trigger} onChange={(v) => setTrigger(v as AutomationTrigger)}
          options={TRIGGERS.map((t) => ({ value: t.id, label: `${t.label} — ${t.hint}` }))} />
      </div>
      <div className="track-auto-field">
        <label>If <span className="track-auto-opt">(optional query)</span></label>
        <input className={`mono${condCheck && !condCheck.ok ? ' bad' : ''}`} value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="type = bug AND priority >= high" />
        {condCheck && !condCheck.ok ? <span className="track-auto-cond-err">{condCheck.error}</span> : null}
      </div>
      <div className="track-auto-field">
        <label>Then</label>
        <div className="track-auto-actions">
          {actions.map((a, i) => (
            <div key={i} className="track-auto-actrow">
              <TrackDropdown className="dd-acttype" value={a.type} onChange={(v) => setAction(i, { type: v as AutomationActionType })}
                options={ACTION_TYPES.map((t) => ({ value: t.id, label: t.label }))} />
              {a.type === 'set-status' ? (
                <TrackDropdown value={a.value} placeholder="status…" onChange={(v) => setAction(i, { value: v })}
                  options={states.map((s) => ({ value: s.id, label: s.name }))} />
              ) : a.type === 'set-priority' ? (
                <TrackDropdown value={a.value} placeholder="priority…" onChange={(v) => setAction(i, { value: v })}
                  options={(['urgent', 'high', 'medium', 'low', 'none'] as const).map((p) => ({ value: p, label: p }))} />
              ) : (
                <input value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} placeholder={ACTION_TYPES.find((t) => t.id === a.type)?.placeholder} />
              )}
              {actions.length > 1 ? <button className="track-auto-actdel" title="Remove action" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button> : null}
            </div>
          ))}
          <button className="track-auto-addact" onClick={() => setActions((as) => [...as, { type: 'add-label', value: '' }])}><Icon name="plus" size={11} /> Add action</button>
        </div>
      </div>
      <div className="track-auto-form-actions">
        <button className="track-auto-save" disabled={!valid} onClick={submit}>Create rule</button>
        <button className="track-auto-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
