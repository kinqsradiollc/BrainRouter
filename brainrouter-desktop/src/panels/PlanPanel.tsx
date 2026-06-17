/**
 * The Plan panel: the agent's live plan (update_plan), rendered as a checklist,
 * plus §7 plan REVIEW — an approval banner, Approve / Request-changes controls,
 * and the durable version history (each decision snapshots the plan, so the
 * list doubles as the plan's version log with a diff from the previous
 * snapshot). Pure view logic lives in lib/plan/planReviewView; the store is the
 * CLI's planHistoryStore over the host endpoints — no parallel state.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import { Button } from '../components/Button.js';
import {
  planHistoryRows, planApprovalState, approvalLabel, isEmptyDiff,
  type PlanDecisionView,
} from '../lib/plan/planReviewView.js';
import type { PlanItem } from '../types.js';

export function PlanPanel({ plan, history, onApprove, onRequestChanges }: {
  plan: { items: PlanItem[]; explanation?: string } | null;
  history?: PlanDecisionView[];
  onApprove?: () => void;
  onRequestChanges?: (feedback: string) => void;
}): React.ReactElement {
  const [feedback, setFeedback] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const decisions = history ?? [];

  if (!plan || plan.items.length === 0) {
    return (
      <div className="empty center-empty panel-empty">
        <Icon name="plan" size={18} />
        <div>No plan yet</div>
        <span className="dim">The agent writes its plan here as it works.</span>
      </div>
    );
  }

  const state = planApprovalState(plan, decisions);
  const rows = planHistoryRows(decisions);
  const submitChanges = (): void => {
    if (!feedback.trim() || !onRequestChanges) return;
    onRequestChanges(feedback.trim());
    setFeedback('');
  };

  return (
    <div className="scroll">
      {onApprove ? (
        <div className={`plan-review-banner pr-${state.kind}`}>
          <span className="plan-review-state">{approvalLabel(state)}</span>
          {state.kind === 'changes-requested' && state.feedback ? <span className="plan-review-fb">“{state.feedback}”</span> : null}
          {state.kind === 'changed-since-approval' ? <span className="plan-review-fb dim">the plan changed since it was approved — re-approve to confirm</span> : null}
        </div>
      ) : null}

      {plan.explanation ? <div className="plan-why">{plan.explanation}</div> : null}
      {plan.items.map((it, i) => (
        <div key={i} className={`plan-item ${it.status}`}>
          <span className="plan-mark">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'}</span>
          <span className="plan-step">{it.step}{it.acceptance ? <span className="plan-acceptance">✓ {it.acceptance}</span> : null}</span>
        </div>
      ))}

      {onApprove ? (
        <div className="plan-review-controls">
          <Button variant="primary" onClick={onApprove} title="Record an approval — snapshots the plan as a version">Approve plan</Button>
          <div className="sched-add-row">
            <input className="filter" placeholder="request changes (feedback returns to the session)" value={feedback}
              onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitChanges(); }} />
            <button className="sched-add-btn" onClick={submitChanges} disabled={!feedback.trim()}>Request changes</button>
          </div>
          {rows.length ? (
            <button className="plan-history-toggle" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? '▾' : '▸'} Version history ({rows.length})
            </button>
          ) : null}
        </div>
      ) : null}

      {showHistory && rows.length ? (
        <div className="plan-history">
          {rows.map((d) => (
            <div key={d.id} className="plan-decision">
              <div className="plan-decision-head">
                <span className={`plan-verdict v-${d.verdict}`}>{d.verdict === 'approved' ? 'approved' : 'changes requested'}</span>
                <span className="plan-decision-meta">{d.planSnapshot.length} item{d.planSnapshot.length === 1 ? '' : 's'} · {fmtTime(d.createdAt)}</span>
                <span className="req-id">{d.id}</span>
              </div>
              {d.feedback ? <div className="plan-decision-fb">“{d.feedback}”</div> : null}
              {d.diffFromPrev && !isEmptyDiff(d.diffFromPrev) ? (
                <div className="plan-decision-diff">
                  {d.diffFromPrev.added.length ? <span className="diff-add">+{d.diffFromPrev.added.length}</span> : null}
                  {d.diffFromPrev.removed.length ? <span className="diff-del">−{d.diffFromPrev.removed.length}</span> : null}
                  {d.diffFromPrev.changed.length ? <span className="diff-mod">~{d.diffFromPrev.changed.length} status</span> : null}
                  <span className="dim"> vs previous</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
