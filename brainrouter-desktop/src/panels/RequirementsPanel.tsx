/**
 * REQUIREMENT-RECORDS — the Requirements panel: per-workspace Requirement
 * Records (structured units of intent — title, status, priority, acceptance
 * criteria, clarifying Q&A, links). Lists this workspace's requirements, shows
 * a selected requirement's detail, and lets you create one, change its status/
 * priority, append an acceptance criterion, and seed a session plan from it.
 * Pure view logic lives in lib/requirements/requirementsView. Wraps the CLI
 * requirementStore over the host endpoints — no parallel state.
 */
import React, { useState } from 'react';
import type { RequirementRecord, RequirementStatus, RequirementPriority } from '@kinqs/brainrouter-types';
import {
  sortRequirements, linkCounts, priorityClass,
  REQUIREMENT_STATUS_OPTIONS, REQUIREMENT_PRIORITY_OPTIONS,
} from '../lib/requirements/requirementsView.js';

export function RequirementsPanel({ requirements, onCreate, onSetStatus, onSetPriority, onAddCriterion, onSeedPlan }: {
  requirements: RequirementRecord[];
  onCreate: (title: string) => void;
  onSetStatus: (id: string, status: RequirementStatus) => void;
  onSetPriority: (id: string, priority: RequirementPriority) => void;
  onAddCriterion: (id: string, text: string) => void;
  onSeedPlan: (id: string) => void;
}): React.ReactElement {
  const [title, setTitle] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [criterion, setCriterion] = useState('');
  const sorted = sortRequirements(requirements);
  // Keep a valid selection: the first row, unless the user picked one that still exists.
  const selected = sorted.find((r) => r.id === selectedId) ?? sorted[0] ?? null;

  const submitCreate = (): void => {
    if (!title.trim()) return;
    onCreate(title.trim());
    setTitle('');
  };
  const submitCriterion = (): void => {
    if (!selected || !criterion.trim()) return;
    onAddCriterion(selected.id, criterion.trim());
    setCriterion('');
  };

  return (
    <div className="scroll req-panel">
      <div className="sched-add">
        <div className="sched-add-row">
          <input className="filter" placeholder="new requirement title" value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }} />
          <button className="sched-add-btn" onClick={submitCreate}>Add</button>
        </div>
      </div>

      {sorted.length === 0 ? <div className="empty">No requirements yet. Add one above to anchor a chat to a structured unit of intent.</div> : (
        <>
          {sorted.map((r) => (
            <button key={r.id} className={`req-row${selected?.id === r.id ? ' active' : ''}`} onClick={() => setSelectedId(r.id)}>
              <span className={`req-prio sev sev-${priorityClass(r.priority)}`} title={`priority: ${r.priority}`}>{r.priority}</span>
              <span className={`req-status st-${r.status}`}>{r.status}</span>
              <span className="req-title">{r.title}</span>
              <span className="req-id">{r.id}</span>
            </button>
          ))}

          {selected ? <RequirementDetail
            req={selected}
            criterion={criterion}
            setCriterion={setCriterion}
            onSetStatus={onSetStatus}
            onSetPriority={onSetPriority}
            onSubmitCriterion={submitCriterion}
            onSeedPlan={onSeedPlan}
          /> : null}
        </>
      )}

      <div className="sched-note">Requirements persist in <code>.brainrouter/cli/requirements.json</code> — shared with the CLI. “Seed plan” turns the acceptance criteria into this session's task plan.</div>
    </div>
  );
}

function RequirementDetail({ req, criterion, setCriterion, onSetStatus, onSetPriority, onSubmitCriterion, onSeedPlan }: {
  req: RequirementRecord;
  criterion: string;
  setCriterion: (v: string) => void;
  onSetStatus: (id: string, status: RequirementStatus) => void;
  onSetPriority: (id: string, priority: RequirementPriority) => void;
  onSubmitCriterion: () => void;
  onSeedPlan: (id: string) => void;
}): React.ReactElement {
  const links = linkCounts(req);
  return (
    <div className="req-detail">
      <div className="req-detail-head">
        <span className="req-detail-title">{req.title}</span>
        <span className="req-id">{req.id}</span>
      </div>

      {req.description ? <div className="req-desc">{req.description}</div> : null}

      <div className="req-controls">
        <label className="req-select">
          <span>Status</span>
          <select className="filter" value={req.status} onChange={(e) => onSetStatus(req.id, e.target.value as RequirementStatus)}>
            {REQUIREMENT_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="req-select">
          <span>Priority</span>
          <select className="filter" value={req.priority} onChange={(e) => onSetPriority(req.id, e.target.value as RequirementPriority)}>
            {REQUIREMENT_PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <button className="wt-btn" disabled={req.acceptanceCriteria.length === 0}
          title={req.acceptanceCriteria.length === 0 ? 'Add an acceptance criterion first' : 'Turn the acceptance criteria into this session\'s plan'}
          onClick={() => onSeedPlan(req.id)}>Seed plan</button>
      </div>

      <div className="tasks-section"><span>Acceptance criteria</span></div>
      {req.acceptanceCriteria.length === 0 ? <div className="empty">No acceptance criteria yet.</div> : (
        <ul className="req-list">
          {req.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
      <div className="sched-add-row">
        <input className="filter" placeholder="add acceptance criterion" value={criterion} onChange={(e) => setCriterion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmitCriterion(); }} />
        <button className="sched-add-btn" onClick={onSubmitCriterion}>Add</button>
      </div>

      {req.clarifyingQuestions.length ? (
        <>
          <div className="tasks-section"><span>Clarifying Q&amp;A</span></div>
          <ul className="req-list req-qa">
            {req.clarifyingQuestions.map((qa, i) => (
              <li key={i}>
                <div className="req-q">Q: {qa.question}</div>
                {qa.answer ? <div className="req-a">A: {qa.answer}</div> : <div className="req-a unanswered">— unanswered</div>}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="tasks-section"><span>Links</span></div>
      <div className="req-links">
        <span className="req-link-chip">{links.tasks} task{links.tasks === 1 ? '' : 's'}</span>
        <span className="req-link-chip">{links.artifacts} artifact{links.artifacts === 1 ? '' : 's'}</span>
        <span className="req-link-chip">{links.memory} memor{links.memory === 1 ? 'y' : 'ies'}</span>
      </div>
    </div>
  );
}
