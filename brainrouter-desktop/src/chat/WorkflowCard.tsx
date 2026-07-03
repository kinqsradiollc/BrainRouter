/**
 * DESK-6w — the /workflows-style card. Header (kind·slug + status + elapsed +
 * totals), then one section per phase: title, a progress-dot strip (one dot per
 * agent, colored by that agent's status), and an Agent | Tokens | Tools | Time table.
 */
import React from 'react';
import type { WorkflowDetail } from '../types.js';
import { fmtTokens, fmtDur, wfStatusClass } from '../lib/format.js';
import { WorkElapsed } from '../components/status/WorkElapsed.js';

export function WorkflowCard({ wf, onBack }: { wf: WorkflowDetail; onBack: () => void }): React.ReactElement {
  const started = new Date(wf.startedAt).getTime();
  const live = wf.status === 'running';
  return (
    <div className="wf-card">
      <div className="wf-head">
        <button className="task-back" onClick={onBack}>← Back</button>
        <span className="wf-title">{wf.kind ? `${wf.kind} · ` : ''}{wf.slug}</span>
        <span className={`task-status ${wfStatusClass(wf.status)}`}>{wf.status}</span>
        <span className="wf-elapsed">{live ? <WorkElapsed startedAt={started} /> : fmtDur(new Date(wf.updatedAt).getTime() - started)}</span>
      </div>
      <div className="wf-meta">
        <span><b>{wf.totalAgents}</b> agent{wf.totalAgents === 1 ? '' : 's'}</span>
        <span className="dim">·</span>
        <span><b>{fmtTokens(wf.totalTokens)}</b> tokens</span>
      </div>
      {wf.phases.length === 0 && wf.steps.length > 0 ? (
        <div className="wf-phase">
          <div className="wf-phase-head"><span className="wf-phase-title">Steps</span></div>
          {wf.steps.map((st) => (
            <div key={st.id} className="wf-step"><span className={`wf-dot ${wfStatusClass(st.status)}`} /><span>{st.title}</span><span className="wf-step-status dim">{st.status}</span></div>
          ))}
        </div>
      ) : null}
      {wf.phases.map((p) => (
        <div key={p.id} className="wf-phase">
          <div className="wf-phase-head">
            <span className="wf-phase-title">{p.title}</span>
            <span className={`task-status ${wfStatusClass(p.status)}`}>{p.status}</span>
            <span className="wf-dots">{p.agents.map((a) => <span key={a.id} className={`wf-dot ${wfStatusClass(a.status)}`} title={`${a.label} — ${a.status}`} />)}</span>
          </div>
          {p.agents.length > 0 ? (
            <div className="wf-table">
              <div className="wf-row wf-row-head"><span>Agent</span><span>Tokens</span><span>Tools</span><span>Time</span></div>
              {p.agents.map((a) => (
                <div key={a.id} className="wf-row" title={`${a.role} · ${a.status}`}>
                  <span className="wf-agent"><span className={`wf-dot ${wfStatusClass(a.status)}`} />{a.label}</span>
                  <span>{fmtTokens(a.tokens)}</span>
                  <span>{a.tools}</span>
                  <span>{fmtDur(a.ms)}</span>
                </div>
              ))}
            </div>
          ) : <div className="wf-empty dim">No agents in this phase yet.</div>}
        </div>
      ))}
    </div>
  );
}
