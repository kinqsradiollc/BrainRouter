/**
 * The Plan panel: the agent's live plan (update_plan), rendered as a checklist,
 * plus §7 plan REVIEW — an approval banner, Approve / Request-changes controls,
 * and the durable version history (each decision snapshots the plan, so the
 * list doubles as the plan's version log with a diff from the previous
 * snapshot). Pure view logic lives in lib/plan/planReviewView; the store is the
 * CLI's planHistoryStore over the host endpoints — no parallel state.
 */
import React, { useState } from 'react';
import { Icon } from '../../icons.js';
import { Button } from '../../components/primitives/Button.js';
import {
  planHistoryRows, planApprovalState, approvalLabel, isEmptyDiff,
  type PlanDecisionView,
} from '../../lib/plan/planReviewView.js';
import type { PlanItem } from '../../types.js';

export function PlanPanel({ plan, history, annotations, onApprove, onRequestChanges, onAnnotateStep }: {
  plan: { items: PlanItem[]; explanation?: string } | null;
  history?: PlanDecisionView[];
  /** Open comments on plan steps (type 'plan'), matched per step by targetId. */
  annotations?: Array<{ id: string; type?: string; targetId?: string; body: string; status?: string }>;
  onApprove?: () => void;
  onRequestChanges?: (feedback: string) => void;
  onAnnotateStep?: (item: PlanItem, index: number, body: string) => void;
}): React.ReactElement {
  const [feedback, setFeedback] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  // §plan-comments — inline composer state (Electron's renderer has no
  // window.prompt, so a step comment is collected via an in-panel input).
  const [annotating, setAnnotating] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const decisions = history ?? [];
  // Comments live in the shared annotation store; each plan step's are anchored
  // by targetId `plan-step:<n>` (1-based). Open ones drive the next revision.
  const openNotes = (annotations ?? []).filter((n) => (!n.type || n.type === 'plan') && n.status !== 'resolved' && n.status !== 'rejected' && n.status !== 'ignored');
  const notesForStep = (index: number): typeof openNotes => openNotes.filter((n) => n.targetId === `plan-step:${index + 1}`);

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
  // A finished plan (every step completed) needs no approval — show a complete
  // banner and drop the Approve / Request-changes controls (the version history
  // stays available below).
  const allDone = plan.items.every((it) => it.status === 'completed');
  const submitChanges = (): void => {
    if (!onRequestChanges || (!feedback.trim() && openNotes.length === 0)) return;
    onRequestChanges(feedback.trim());
    setFeedback('');
  };
  const submitAnnotation = (item: PlanItem, index: number): void => {
    if (!onAnnotateStep || !draft.trim()) return;
    onAnnotateStep(item, index, draft.trim());
    setDraft(''); // keep the composer open so the new comment appears in the thread
  };

  return (
    <div className="scroll">
      {onApprove ? (
        <div className={`plan-review-banner pr-${allDone ? 'complete' : state.kind}`}>
          <span className="plan-review-state">{allDone ? '✓ Plan complete' : approvalLabel(state)}</span>
          {!allDone && state.kind === 'changes-requested' && state.feedback ? <span className="plan-review-fb">“{state.feedback}”</span> : null}
          {!allDone && state.kind === 'changed-since-approval' ? <span className="plan-review-fb dim">the plan changed since it was approved — re-approve to confirm</span> : null}
        </div>
      ) : null}

      {plan.explanation ? <div className="plan-why">{plan.explanation}</div> : null}
      {plan.items.map((it, i) => {
        const notes = notesForStep(i);
        const open = annotating === i;
        return (
          <div key={i} className="plan-item-wrap">
            <div className={`plan-item ${it.status}`}>
              <span className="plan-mark">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'}</span>
              <span className="plan-step">{it.step}{it.acceptance ? <span className="plan-acceptance">✓ {it.acceptance}</span> : null}</span>
              {onAnnotateStep ? (
                <button className={`plan-annotate-btn${notes.length ? ' has-notes' : ''}${open ? ' open' : ''}`} title="Comment on this step"
                  onClick={() => { setAnnotating(open ? null : i); setDraft(''); }}>
                  <Icon name="bubble" size={12} />{notes.length ? <span className="plan-annotate-count">{notes.length}</span> : null}
                </button>
              ) : null}
            </div>
            {onAnnotateStep && open ? (
              <div className="plan-annotations">
                {notes.map((n) => <div key={n.id} className="plan-annotation">{n.body}</div>)}
                <div className="plan-annotate-compose">
                  <input className="filter" autoFocus placeholder="Comment on this step…" value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitAnnotation(it, i); if (e.key === 'Escape') { setAnnotating(null); setDraft(''); } }} />
                  <button className="btn" disabled={!draft.trim()} onClick={() => submitAnnotation(it, i)}>Add</button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {onApprove ? (
        <div className="plan-review-controls">
          {allDone ? (
            <div className="plan-complete-note">All steps are done — nothing to approve.</div>
          ) : (
            <>
              <input className="filter plan-feedback-input" placeholder={openNotes.length ? `Optional — ${openNotes.length} step comment${openNotes.length === 1 ? '' : 's'} will be sent` : 'Note for “Request changes”…'} value={feedback}
                onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitChanges(); }} />
              <div className="plan-review-actions">
                <Button variant="primary" onClick={onApprove} title="Record an approval — snapshots the plan as a version">Approve plan</Button>
                <Button variant="default" onClick={submitChanges} disabled={!feedback.trim() && openNotes.length === 0} title="Send feedback + step comments and start a background revision task">Request changes</Button>
              </div>
            </>
          )}
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
                <span className={`plan-verdict v-${d.verdict}`}>{d.verdict === 'approved' ? 'approved' : d.verdict === 'revised' ? 'revised' : 'changes requested'}{d.actor === 'auto' ? ' · auto' : ''}</span>
                <span className="plan-decision-meta">{d.planSnapshot.length} item{d.planSnapshot.length === 1 ? '' : 's'} · {fmtTime(d.createdAt)}</span>
                <span className="req-id">{d.id}</span>
              </div>
              {d.feedback ? <div className="plan-decision-fb">“{d.feedback}”</div> : null}
              {d.diffFromPrev && !isEmptyDiff(d.diffFromPrev) ? (
                <div className="plan-decision-diff">
                  <div className="plan-diff-label">vs previous</div>
                  {d.diffFromPrev.added.map((step) => <div key={`a-${step}`} className="plan-diff-line diff-add">+ {step}</div>)}
                  {d.diffFromPrev.removed.map((step) => <div key={`r-${step}`} className="plan-diff-line diff-del">− {step}</div>)}
                  {d.diffFromPrev.changed.map((c) => (
                    <div key={`c-${c.step}`} className="plan-diff-line diff-mod">~ {c.step} <span>{c.from} → {c.to}</span></div>
                  ))}
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
