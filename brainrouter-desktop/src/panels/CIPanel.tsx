/**
 * T6 — GitHub CI/CD panel. PR header, the check-run rollup, recent Actions runs
 * (expand → jobs + log tail), and Open-on-GitHub / Refresh / Watch / Rerun-failed.
 * Pure UI over the useCi hook. CI status here is GitHub's truth — clearly labeled,
 * never conflated with the app's local "tests passed".
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons.js';
import { Button } from '../components/Button.js';
import { summarizeChecks, ciStatusLabel, checkClass, runClass, ciDuration, type CheckRow } from '../lib/ci/ciFormat.js';
import type { CiApi } from '../lib/ci/useCi.js';
import { summarizePrReadiness } from '../lib/track/prReadiness.js';
import type { TrackPrStatus } from '../track/TrackView.js';

type PrBusy = 'refresh' | 'review' | 'fix-checks' | 'merge' | null;
type TrackPrOps = {
  refreshPr: () => void;
  mergePr: () => void;
  submitPrReview: (decision: 'comment' | 'approve' | 'request-changes', body: string) => void;
  fixFailingChecks: () => void;
};

export function CIPanel({ ci, onOpenExternal, onReviewPr, trackPr, trackOps }: {
  ci: CiApi;
  onOpenExternal: (url: string) => void;
  onReviewPr?: (pr: { number: number; title?: string; headRefName?: string; baseRefName?: string }) => void;
  trackPr?: TrackPrStatus | null;
  trackOps?: TrackPrOps;
}): React.ReactElement {
  const summary = summarizeChecks(ci.checks);
  const [runBusy, setRunBusy] = useState<{ kind: 'log' | 'rerun' | null; id: number | null }>({ kind: null, id: null });
  const [prBusy, setPrBusy] = useState<PrBusy>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDecision, setReviewDecision] = useState<'comment' | 'approve' | 'request-changes'>('comment');
  const [reviewBody, setReviewBody] = useState('');
  // Separate the all-PRs browse view from the current-branch CI checks.
  const [tab, setTab] = useState<'prs' | 'checks'>('prs');
  const [expandedPr, setExpandedPr] = useState<number | null>(null);
  // Initial load when the panel opens (once); manual Refresh + Watch handle the rest.
  const refreshRef = useRef(ci.refresh); refreshRef.current = ci.refresh;
  const trackRefreshRef = useRef(trackOps?.refreshPr); trackRefreshRef.current = trackOps?.refreshPr;
  useEffect(() => { refreshRef.current(); trackRefreshRef.current?.(); }, []);
  useEffect(() => { setRunBusy({ kind: null, id: null }); }, [ci.runLog, ci.runs]);
  useEffect(() => { setPrBusy(null); }, [trackPr]);
  const runAction = (kind: 'log' | 'rerun', id: number, fn: () => void): void => {
    setRunBusy({ kind, id });
    fn();
    window.setTimeout(() => setRunBusy((cur) => (cur.kind === kind && cur.id === id ? { kind: null, id: null } : cur)), 12_000);
  };
  const runPrAction = (kind: Exclude<PrBusy, null>, fn: () => void): void => {
    setPrBusy(kind);
    fn();
    window.setTimeout(() => setPrBusy((cur) => (cur === kind ? null : cur)), 15_000);
  };
  const refreshAll = (): void => runPrAction('refresh', () => { ci.refresh(); trackOps?.refreshPr(); });
  const submitReview = (): void => {
    if (!trackPr?.pr || !trackOps) return;
    runPrAction('review', () => {
      trackOps.submitPrReview(reviewDecision, reviewBody);
      setReviewOpen(false);
      setReviewBody('');
      setReviewDecision('comment');
    });
  };
  const pr = trackPr?.pr ?? ci.pr;
  const readiness = summarizePrReadiness(trackPr?.pr ?? ci.pr);
  const canUsePrOps = !!trackOps && !!trackPr?.pr;
  const errors = [...new Set([ci.error, trackPr?.error].filter((e): e is string => !!e))];
  return (
    <div className="scroll ci-panel">
      <div className="ci-bar">
        <button className={`btn primary${ci.loading || prBusy === 'refresh' ? ' is-busy' : ''}`} disabled={ci.loading || !!prBusy} onClick={refreshAll}>{ci.loading || prBusy === 'refresh' ? <span className="spinner sm" /> : null}{ci.loading || prBusy === 'refresh' ? 'Refreshing' : 'Refresh'}</button>
        {pr?.url ? <Button onClick={() => onOpenExternal(pr.url!)}>Open on GitHub</Button> : null}
      </div>
      {errors.map((error) => <div key={error} className="ci-error"><Icon name="warn" size={13} /> {error}</div>)}

      <div className="ci-tabs">
        <button type="button" className={`ci-tab${tab === 'prs' ? ' active' : ''}`} onClick={() => setTab('prs')}>Pull Requests{ci.prs.length ? ` (${ci.prs.length})` : ''}</button>
        <button type="button" className={`ci-tab${tab === 'checks' ? ' active' : ''}`} onClick={() => setTab('checks')}>Checks</button>
      </div>

      {tab === 'prs' ? (
        ci.prs.length === 0
          ? <div className="empty">No open pull requests. <span className="dim">(needs `gh` authed)</span></div>
          : <div className="ci-pr-list">
              {ci.prs.map((p) => {
                const expanded = expandedPr === p.number;
                const st = (p.isDraft ? 'draft' : (p.state ?? 'open')).toLowerCase();
                return (
                  <div key={p.number} className="ci-pr-item">
                    <button type="button" className="ci-pr-item-head" onClick={() => setExpandedPr(expanded ? null : p.number)}>
                      <span className={`ci-pr-state ${st}`}>{st}</span>
                      <span className="ci-pr-item-main">
                        <span className="ci-pr-title" title={p.title}>#{p.number} {p.title}</span>
                        <span className="ci-pr-branch">{p.headRefName} → {p.baseRefName}{p.author?.login ? ` · ${p.author.login}` : ''}</span>
                      </span>
                      <span className="step-chevron">{expanded ? '⌄' : '›'}</span>
                    </button>
                    {expanded ? (
                      <div className="ci-pr-detail">
                        <pre className="ci-pr-bodytext">{(p.body && p.body.trim()) || '(no description provided)'}</pre>
                        <div className="ci-run-actions">
                          {onReviewPr ? <Button onClick={() => onReviewPr({ number: p.number, title: p.title, headRefName: p.headRefName, baseRefName: p.baseRefName })}><Icon name="review" size={12} />Review with AI</Button> : null}
                          {p.url ? <Button onClick={() => onOpenExternal(p.url!)}>Open on GitHub</Button> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
      ) : (<>

      {pr ? (
        <div className="ci-pr">
          <span className={`ci-pr-state ${String(pr.state ?? '').toLowerCase()}`}>{pr.isDraft ? 'draft' : (pr.state ?? '').toLowerCase()}</span>
          <span className="ci-pr-title" title={pr.title}>#{pr.number} {pr.title}</span>
          <span className="ci-pr-branch">{pr.headRefName} → {pr.baseRefName}</span>
        </div>
      ) : <div className="empty">No pull request for this branch. <span className="dim">(needs `gh` authed + an open PR)</span></div>}

      <div className={`track-pr-ready ${readiness.state}`}>
        <div className="track-pr-ready-head">
          <span className="track-pr-ready-title">Merge readiness</span>
          <span className="track-pr-ready-counts">{readiness.passing} pass · {readiness.failing} fail · {readiness.pending} pending</span>
        </div>
        <div className="track-pr-ready-notes">
          {readiness.notes.map((note, i) => <span key={i}>{note}</span>)}
        </div>
      </div>

      <div className="ci-pr-actions">
        <Button className={prBusy === 'review' ? 'is-busy' : ''} disabled={!canUsePrOps || !!prBusy} onClick={() => setReviewOpen(true)}>{prBusy === 'review' ? <span className="spinner sm" /> : <Icon name="review" size={12} />}Review</Button>
        <Button className={prBusy === 'fix-checks' ? 'is-busy' : ''} disabled={!canUsePrOps || !!prBusy || readiness.failing === 0} onClick={() => runPrAction('fix-checks', () => trackOps!.fixFailingChecks())}>{prBusy === 'fix-checks' ? <span className="spinner sm" /> : <Icon name="bolt" size={12} />}{prBusy === 'fix-checks' ? 'Starting' : 'Fix checks'}</Button>
        <Button className={prBusy === 'merge' ? 'is-busy' : ''} disabled={!canUsePrOps || !!prBusy || trackPr?.pr?.isDraft} onClick={() => runPrAction('merge', () => trackOps!.mergePr())}>{prBusy === 'merge' ? <span className="spinner sm" /> : <Icon name="check-circle" size={12} />}{prBusy === 'merge' ? 'Merging' : 'Merge PR'}</Button>
      </div>

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
                  <Button className={runBusy.kind === 'log' && runBusy.id === id ? 'is-busy' : ''} disabled={!!runBusy.kind} onClick={() => runAction('log', id, () => ci.loadLog(id))}>{runBusy.kind === 'log' && runBusy.id === id ? <span className="spinner sm" /> : null}Log tail</Button>
                  <Button className={runBusy.kind === 'log' && runBusy.id === id ? 'is-busy' : ''} disabled={!!runBusy.kind} onClick={() => runAction('log', id, () => ci.loadLog(id, true))}>{runBusy.kind === 'log' && runBusy.id === id ? <span className="spinner sm" /> : null}Failed log</Button>
                  <Button className={runBusy.kind === 'rerun' && runBusy.id === id ? 'is-busy' : ''} disabled={!!runBusy.kind} onClick={() => runAction('rerun', id, () => ci.rerunFailed(id))}>{runBusy.kind === 'rerun' && runBusy.id === id ? <span className="spinner sm" /> : null}Rerun failed</Button>
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
      </>)}
      {reviewOpen && trackPr?.pr ? (
        <div className="track-modal-backdrop" onClick={() => setReviewOpen(false)}>
          <div className="track-review-modal" onClick={(e) => e.stopPropagation()}>
            <div className="track-review-modal-head">
              <div>
                <div className="track-review-modal-title">Review PR #{trackPr.pr.number}</div>
                <div className="track-review-modal-sub">{trackPr.pr.title}</div>
              </div>
              <button className="track-modal-close" title="Close" onClick={() => setReviewOpen(false)}><Icon name="close" size={13} /></button>
            </div>
            <textarea className="track-review-body" autoFocus value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} placeholder="Review comment" />
            <div className="track-review-options">
              {([
                ['comment', 'Comment'],
                ['approve', 'Approve'],
                ['request-changes', 'Request changes'],
              ] as const).map(([id, label]) => (
                <label key={id} className={`track-review-option${reviewDecision === id ? ' active' : ''}`}>
                  <input type="radio" checked={reviewDecision === id} onChange={() => setReviewDecision(id)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="track-review-actions">
              <button className="track-auto-cancel" onClick={() => setReviewOpen(false)}>Cancel</button>
              <button className="track-auto-save" disabled={reviewDecision === 'comment' && !reviewBody.trim()} onClick={submitReview}>Submit review</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
