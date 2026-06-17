/** The Plan panel: the agent's live plan (update_plan), rendered as a checklist. */
import React from 'react';
import { Icon } from '../icons.js';

export function PlanPanel({ plan }: {
  plan: { items: Array<{ step: string; status: string; acceptance?: string }>; explanation?: string } | null;
}): React.ReactElement {
  if (!plan || plan.items.length === 0) {
    return (
      <div className="empty center-empty panel-empty">
        <Icon name="plan" size={18} />
        <div>No plan yet</div>
        <span className="dim">The agent writes its plan here as it works.</span>
      </div>
    );
  }
  return (
    <div className="scroll">
      {plan.explanation ? <div className="plan-why">{plan.explanation}</div> : null}
      {plan.items.map((it, i) => (
        <div key={i} className={`plan-item ${it.status}`}>
          <span className="plan-mark">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'}</span>
          <span className="plan-step">{it.step}{it.acceptance ? <span className="plan-acceptance">✓ {it.acceptance}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}
