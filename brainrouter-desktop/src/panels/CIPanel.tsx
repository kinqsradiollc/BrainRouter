/**
 * T6 — GitHub CI/CD panel. PR header, the check-run rollup, recent Actions runs
 * (expand → jobs + log tail), and Open-on-GitHub / Refresh / Watch / Rerun-failed.
 * Pure UI over the useCi hook. CI status here is GitHub's truth — clearly labeled,
 * never conflated with the app's local "tests passed".
 */
import React, { useEffect, useRef } from 'react';
import { Icon } from '../icons.js';
import { Button } from '../components/Button.js';
import { summarizeChecks, ciStatusLabel, checkClass, runClass, ciDuration, type CheckRow } from '../lib/ci/ciFormat.js';
import type { CiApi } from '../lib/ci/useCi.js';

export function CIPanel({ ci, onOpenExternal }: { ci: CiApi; onOpenExternal: (url: string) => void }): React.ReactElement {
  const summary = summarizeChecks(ci.checks);
  // Initial load when the panel opens (once); manual Refresh + Watch handle the rest.
  const refreshRef = useRef(ci.refresh); refreshRef.current = ci.refresh;
  useEffect(() => { refreshRef.current(); }, []);
  return (
    <div className="scroll ci-panel">
      <div className="ci-bar">
        <button className="btn primary" disabled={ci.loading} onClick={ci.refresh}>{ci.loading ? 'Refreshing…' : 'Refresh'}</button>
        {ci.pr?.url ? <Button onClick={() => onOpenExternal(ci.pr!.url!)}>Open on GitHub</Button> : null}
      </div>

      {ci.pr ? (
        <div className="ci-pr">
          <span className={`ci-pr-state ${String(ci.pr.state ?? '').toLowerCase()}`}>{ci.pr.isDraft ? 'draft' : (ci.pr.state ?? '').toLowerCase()}</span>
          <span className="ci-pr-title" title={ci.pr.title}>#{ci.pr.number} {ci.pr.title}</span>
          <span className="ci-pr-branch">{ci.pr.headRefName} → {ci.pr.baseRefName}</span>
        </div>
      ) : <div className="empty">No pull request for this branch. <span className="dim">(needs `gh` authed + an open PR)</span></div>}

      {/* Check-run rollup — GitHub's CI, NOT the local tool log. */}
      <div className="ci-section"><span>Checks</span></div>
      <div className={`ci-status ci-${summary.conclusion}`}>
        <span className="ci-dot" />{ciStatusLabel(summary)}
      </div>
      {ci.checks.map((c: CheckRow, i) => (
        <div key={i} className="ci-check" onClick={() => c.link && onOpenExternal(c.link)} title={c.link ? 'Open on GitHub' : undefined}>
          <span className={`ci-dot ${checkClass(c.bucket)}`} />
          <span className="ci-check-name">{c.name}</span>
          {c.workflow ? <span className="ci-check-wf">{c.workflow}</span> : null}
          <span className="ci-check-dur">{ciDuration(c.startedAt, c.completedAt)}</span>
        </div>
      ))}

      <div className="ci-section"><span>Recent runs</span></div>
      {ci.runs.length === 0 ? <div className="empty">No workflow runs.</div> : ci.runs.map((r) => {
        const id = r.databaseId ?? 0;
        const expanded = ci.expandedRunId === id;
        return (
          <div key={id} className="ci-run">
            <button className="ci-run-head" onClick={() => ci.expandRun(id)}>
              <span className={`ci-dot ${runClass(r)}`} />
              <span className="ci-run-main">
                <span className="ci-run-title" title={r.displayTitle}>{r.workflowName || r.name}: {r.displayTitle}</span>
                <span className="ci-run-meta">{r.headBranch}{r.event ? ` · ${r.event}` : ''}</span>
              </span>
              <span className="step-chevron">{expanded ? '⌄' : '›'}</span>
            </button>
            {expanded ? (
              <div className="ci-run-body">
                <div className="ci-run-actions">
                  {r.url ? <Button onClick={() => onOpenExternal(r.url!)}>Open</Button> : null}
                  <Button onClick={() => ci.loadLog(id)}>Log tail</Button>
                  <Button onClick={() => ci.loadLog(id, true)}>Failed log</Button>
                  <Button onClick={() => ci.rerunFailed(id)}>Rerun failed</Button>
                  <button className={`wt-btn${ci.watching === id ? ' primary-ghost' : ''}`} onClick={() => ci.toggleWatch(id)}>{ci.watching === id ? 'Watching…' : 'Watch'}</button>
                </div>
                {ci.runDetail && ci.runDetail.databaseId === id && ci.runDetail.jobs ? (
                  <div className="ci-jobs">
                    {ci.runDetail.jobs.map((j, ji) => (
                      <div key={ji} className="ci-job"><span className={`ci-dot ${runClass(j)}`} />{j.name}</div>
                    ))}
                  </div>
                ) : null}
                {ci.runLog ? <pre className="ci-log">{ci.runLog.slice(-8000)}</pre> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
