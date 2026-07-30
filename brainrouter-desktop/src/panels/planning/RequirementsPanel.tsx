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
import { Button } from '../../components/primitives/Button.js';
import { Chip } from '../../components/primitives/Badge.js';
import {
  sortRequirements, linkCounts, priorityClass,
  requirementProvenance, REQUIREMENT_STATUS_OPTIONS, REQUIREMENT_PRIORITY_OPTIONS,
} from '../../lib/requirements/requirementsView.js';
import { PM_FRAMEWORKS, type PmFrameworkGroup } from '@kinqs/brainrouter-core/requirement/frameworks';

const FW_GROUPS: ReadonlyArray<{ id: PmFrameworkGroup; label: string }> = [
  { id: 'discover', label: 'Discover' },
  { id: 'structure', label: 'Structure' },
  { id: 'risk', label: 'Risk' },
];

export function RequirementsPanel({ requirements, onCreate, onSetStatus, onSetPriority, onAddCriterion, onSeedPlan, onPromote, onDelete, onApplyFramework }: {
  requirements: RequirementRecord[];
  onCreate: (title: string) => void;
  onSetStatus: (id: string, status: RequirementStatus) => void;
  onSetPriority: (id: string, priority: RequirementPriority) => void;
  onAddCriterion: (id: string, text: string) => void;
  onSeedPlan: (id: string) => void;
  onPromote: (id: string) => void;
  onDelete: (id: string) => void;
  /** §5.1 — inject a PM-framework prompt into the chat composer. */
  onApplyFramework?: (text: string) => void;
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

      {onApplyFramework ? (
        <div className="req-frameworks">
          <div className="req-fw-label">Clarify with a framework — adds a prompt to the composer</div>
          {FW_GROUPS.map((g) => (
            <div key={g.id} className="req-fw-group">
              <span className="req-fw-group-label">{g.label}</span>
              {PM_FRAMEWORKS.filter((f) => f.group === g.id).map((f) => (
                <button key={f.id} className="req-fw-btn" title={f.guidance} onClick={() => onApplyFramework(f.composerText)}>{f.label}</button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {sorted.length === 0 ? <div className="empty">No requirements yet. Add one above to anchor a chat to a structured unit of intent.</div> : (
        <>
          {sorted.map((r) => (
            <button key={r.id} className={`req-row${selected?.id === r.id ? ' active' : ''}`} onClick={() => setSelectedId(r.id)}>
              <span className={`req-prio sev sev-${priorityClass(r.priority)}`} title={`priority: ${r.priority}`}>{r.priority}</span>
              <span className={`req-status st-${r.status}`}>{r.status}</span>
              {r.origin === 'auto' ? <Chip className="req-origin auto">auto</Chip> : null}
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
            onPromote={onPromote}
            onDelete={onDelete}
          /> : null}
        </>
      )}

      <div className="sched-note">Requirements persist in <code>.brainrouter/cli/requirements.json</code> — shared with the CLI. “Seed plan” turns the acceptance criteria into this session's task plan.</div>
    </div>
  );
}

function RequirementDetail({ req, criterion, setCriterion, onSetStatus, onSetPriority, onSubmitCriterion, onSeedPlan, onPromote, onDelete }: {
  req: RequirementRecord;
  criterion: string;
  setCriterion: (v: string) => void;
  onSetStatus: (id: string, status: RequirementStatus) => void;
  onSetPriority: (id: string, priority: RequirementPriority) => void;
  onSubmitCriterion: () => void;
  onSeedPlan: (id: string) => void;
  onPromote: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  // The one-click gate for an auto-captured (or any pre-work) draft: mark ready
  // + plan + Track it in one go.
  const canPromote = req.acceptanceCriteria.length > 0 && (req.status === 'draft' || req.status === 'clarifying' || req.status === 'ready');
  const links = linkCounts(req);
  const provenance = requirementProvenance(req);
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
        {canPromote ? (
          <Button variant="primary" title="Mark ready, seed the plan, and create the Track items in one step"
            onClick={() => onPromote(req.id)}>Plan &amp; track</Button>
        ) : null}
        <Button disabled={req.acceptanceCriteria.length === 0}
          title={req.acceptanceCriteria.length === 0 ? 'Add an acceptance criterion first' : 'Turn the acceptance criteria into this session\'s plan'}
          onClick={() => onSeedPlan(req.id)}>Seed plan</Button>
        <Button variant="danger" title="Delete this requirement" onClick={() => onDelete(req.id)}>Delete</Button>
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
        <Chip>{links.tasks} task{links.tasks === 1 ? '' : 's'}</Chip>
        <Chip>{links.artifacts} artifact{links.artifacts === 1 ? '' : 's'}</Chip>
        <Chip>{links.memory} knowledge record{links.memory === 1 ? '' : 's'}</Chip>
      </div>

      <div className="tasks-section"><span>Automation audit</span></div>
      <div className="req-audit">
        <Chip className={`req-origin ${provenance.origin}`}>{provenance.origin} origin</Chip>
        <div className="req-audit-line">source event: <code>{provenance.sourceEventId ?? 'none'}</code></div>
        {provenance.memoryIds.length ? <div className="req-memory-ids">
          {provenance.memoryIds.map((id) => <Chip key={id} className="req-memory-id">{id}</Chip>)}
        </div> : <div className="req-audit-line">no linked knowledge records</div>}
      </div>
    </div>
  );
}
