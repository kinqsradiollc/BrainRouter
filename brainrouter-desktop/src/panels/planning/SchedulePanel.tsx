/**
 * DESK — the Schedules panel: cron/once jobs that fire slash commands while
 * the CLI agent runs. Persists in `.brainrouter/schedules.json` (shared with
 * the CLI `/schedule`). Pure view logic lives in lib/schedule/scheduleView.
 */
import React, { useState } from 'react';
import { Icon } from '../../icons.js';
import { partitionSchedules, describeSchedule, relTime, type ScheduleRecordView } from '../../lib/schedule/scheduleView.js';

export function SchedulePanel({ schedules, now, onAdd, onRemove, onToggle }: {
  schedules: ScheduleRecordView[];
  now: number;
  onAdd: (kind: 'cron' | 'once', expr: string, command: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}): React.ReactElement {
  const [kind, setKind] = useState<'cron' | 'once'>('cron');
  const [expr, setExpr] = useState('');
  const [command, setCommand] = useState('');
  const { active, disabled } = partitionSchedules(schedules);
  const submit = (): void => {
    if (!expr.trim() || !command.trim()) return;
    onAdd(kind, expr.trim(), command.trim().startsWith('/') ? command.trim() : `/${command.trim()}`);
    setExpr(''); setCommand('');
  };
  const row = (r: ScheduleRecordView): React.ReactElement => (
    <div key={r.id} className={`sched-row${r.enabled ? '' : ' off'}`}>
      <button className="sched-toggle" title={r.enabled ? 'Disable' : 'Enable'} onClick={() => onToggle(r.id, !r.enabled)}>
        <span className={`session-dot${r.enabled ? ' on' : ''}`} />
      </button>
      <div className="sched-main">
        <div className="sched-cmd">{r.command}</div>
        <div className="sched-meta">{describeSchedule(r)} · {r.enabled ? `fires ${relTime(r.nextRun, now)}` : 'paused'}{r.lastRun ? ` · last ${relTime(r.lastRun, now)}` : ''}</div>
      </div>
      <button className="icon-btn" title="Remove" onClick={() => onRemove(r.id)}><Icon name="close" size={11} /></button>
    </div>
  );
  return (
    <div className="scroll sched-panel">
      <div className="sched-add">
        <div className="sched-add-row">
          <button className={`seg-toggle${kind === 'cron' ? ' active' : ''}`} onClick={() => setKind('cron')}>cron</button>
          <button className={`seg-toggle${kind === 'once' ? ' active' : ''}`} onClick={() => setKind('once')}>once</button>
          <input className="filter" placeholder={kind === 'cron' ? '*/15 * * * *' : '2026-06-16T15:30'} value={expr} onChange={(e) => setExpr(e.target.value)} />
        </div>
        <div className="sched-add-row">
          <input className="filter" placeholder="/status   (slash command to run)" value={command} onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="sched-add-btn" onClick={submit}>Add</button>
        </div>
      </div>
      <div className="tasks-section"><span>Active</span></div>
      {active.length === 0 ? <div className="empty">No active schedules.</div> : active.map(row)}
      {disabled.length ? <><div className="tasks-section"><span>Paused</span></div>{disabled.map(row)}</> : null}
      <div className="sched-note">Schedules persist in <code>.brainrouter/schedules.json</code> — shared with the CLI <code>/schedule</code>. They fire while the CLI agent runs.</div>
    </div>
  );
}
