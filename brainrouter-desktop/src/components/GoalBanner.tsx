/**
 * GOAL-BANNER — a persistent, pinned banner at the top of the chat for the
 * active `/goal`. Shows the goal text + status + progress, and edit / pause /
 * resume / delete controls inline, so a goal is a first-class object in the UI
 * (not just a one-off command-output line). Mirrors the CLI's goal lifecycle.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'usage_limited';

/** Renderer-side mirror of the core `Goal` record (the `goal-state` query). */
export interface GoalRecord {
  text: string;
  status: GoalStatus;
  budget: { maxIterations: number; iterationsUsed: number; maxTokens?: number; tokensUsed?: number };
  startedAt: string;
  updatedAt: string;
  blockedReason?: string;
}

export interface GoalBannerProps {
  goal: GoalRecord;
  onResume: () => void;
  onPause: () => void;
  onClear: () => void;
  onEdit: (text: string) => void;
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'working',
  paused: 'paused',
  complete: 'complete',
  blocked: 'blocked',
  usage_limited: 'usage limited',
};

export function GoalBanner({ goal, onResume, onPause, onClear, onEdit }: GoalBannerProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(goal.text);

  const resumable = goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'usage_limited';
  const iters = `${goal.budget.iterationsUsed}/${Number.isFinite(goal.budget.maxIterations) ? goal.budget.maxIterations : '∞'}`;

  const commitEdit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== goal.text) onEdit(next);
    else setDraft(goal.text);
  };

  return (
    <div className={`goal-banner goal-${goal.status}`}>
      <span className="goal-icon" title="Active goal"><Icon name="spark" size={13} /></span>
      <span className={`goal-pill goal-pill-${goal.status}`}>{STATUS_LABEL[goal.status]}</span>

      {editing ? (
        <input
          className="goal-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') { setEditing(false); setDraft(goal.text); } }}
          onBlur={commitEdit}
        />
      ) : (
        <button
          className={`goal-text${expanded ? ' expanded' : ''}`}
          title={expanded ? 'Collapse' : goal.text}
          onClick={() => setExpanded((v) => !v)}
        >
          {goal.text}
        </button>
      )}

      <span className="goal-iters" title="Iterations used / budget">{iters}</span>

      <div className="goal-actions">
        <button className="goal-act" title="Edit goal" onClick={() => { setDraft(goal.text); setEditing(true); }}>
          <Icon name="edit" size={13} />
        </button>
        {resumable ? (
          <button className="goal-act goal-resume" title="Resume goal" onClick={onResume}><Icon name="play" size={13} /></button>
        ) : goal.status === 'active' ? (
          <button className="goal-act" title="Pause goal" onClick={onPause}><Icon name="pause" size={13} /></button>
        ) : null}
        <button className="goal-act goal-del" title="Delete goal" onClick={onClear}><Icon name="trash" size={13} /></button>
      </div>
    </div>
  );
}
