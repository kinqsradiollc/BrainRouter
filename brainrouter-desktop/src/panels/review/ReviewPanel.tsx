/**
 * §2 — the Review panel: a PR-style local code review of the working changes,
 * grouped by file. Each finding shows severity/confidence, a line-numbered
 * code frame (red problem/removed, green suggested/added, neutral context —
 * via the shared reviewCode classifier), an optional patch preview, and the
 * per-finding actions (Apply/Ask-fix/Discuss/Open/Resolve/Dismiss). Commit and
 * push stay blocked until critical/high findings are resolved.
 */
import React, { useState } from 'react';
import { DiffView } from '../diff.js';
import { Button } from '../../components/primitives/Button.js';
import { findingRows } from '../../lib/review/reviewCode.js';
import { codeFileUri, createAndCite } from '../../lib/workspace/crossMode.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { GATE_LABEL, type ReviewFindingView, type ReviewGateView } from '../reviewShared.js';

/** §2 — line-numbered code frame: red problem/removed, green suggested/added,
 *  neutral context — reusing the shared diff-line classification (reviewCode). */
function ReviewCodeFrame({ f }: { f: ReviewFindingView }): React.ReactElement | null {
  const [showPatch, setShowPatch] = useState(false);
  const rows = findingRows(f);
  if (!rows.length && !f.patch) return null;
  const sign = (k: string) => (k === 'add' ? '+' : k === 'del' ? '−' : k === 'problem' ? '!' : '');
  return (
    <div className="rcf">
      {rows.length ? (
        <div className="rcf-code">
          {rows.map((r, i) => (
            <div key={i} className={`rcf-row rcf-${r.kind}`}>
              <span className="rcf-gutter">{r.lineNo ?? ''}</span>
              <span className="rcf-sign">{sign(r.kind)}</span>
              <span className="rcf-text">{r.text || ' '}</span>
            </div>
          ))}
        </div>
      ) : null}
      {f.patch ? (
        <div className="rcf-patch">
          <button className="rcf-patch-toggle" onClick={() => setShowPatch((s) => !s)}>{showPatch ? '▾ Hide patch' : '▸ Preview patch'}</button>
          {showPatch ? <div className="rcf-patch-body"><DiffView diff={f.patch} /></div> : null}
        </div>
      ) : null}
    </div>
  );
}

export type TriageStatus = 'acknowledged' | 'disputed' | 'out-of-scope';

export function ReviewPanel({ review, gate, running, onRun, onDiscuss, onApply, onAskFix, onDismiss, onResolve, onTriage, onAnnotate, onOpenFile, onOpenDiff }: {
  review: { findings: ReviewFindingView[]; summary: string; files: number } | null;
  gate: ReviewGateView | null;
  running: boolean;
  onRun: () => void;
  onDiscuss: (f: ReviewFindingView) => void;
  onApply: (f: ReviewFindingView) => void;
  onAskFix: (f: ReviewFindingView) => void;
  onDismiss: (f: ReviewFindingView) => void;
  onResolve: (f: ReviewFindingView) => void;
  onTriage: (f: ReviewFindingView, status: TriageStatus) => void;
  // §9 — turn a review finding into a durable Annotation Record.
  onAnnotate: (f: ReviewFindingView) => void;
  onOpenFile: (f: ReviewFindingView) => void;
  onOpenDiff: (f: ReviewFindingView) => void;
}): React.ReactElement {
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const findings = [...(review?.findings ?? [])].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  /**
   * ADR-029 C2 — Code → Notes.
   *
   * The reference goes to the FILE rather than to the finding, because only one
   * review run is kept per workspace: a note pointing at the finding would
   * dangle after the next run with nothing to tombstone. The file survives, and
   * the finding's own words travel with the note.
   */
  const findingToNote = (f: ReviewFindingView): Promise<unknown> => createAndCite({
    mode: 'notes', kind: 'block',
    title: `${f.severity}: ${f.summary}`,
    from: undefined,
    fields: { kind: 'todo' },
  }).then((created) => (created.ok
    ? bridgeQuery('workspace-link', {
        from: created.uri,
        to: `${codeFileUri(f.file)}${f.line ? `#L${f.line}` : ''}`,
      })
    : created));
  const byFile = new Map<string, ReviewFindingView[]>();
  for (const f of findings) { const a = byFile.get(f.file) ?? []; a.push(f); byFile.set(f.file, a); }
  return (
    <div className="scroll review-panel">
      <div className="review-bar">
        <button className="btn primary" disabled={running} onClick={onRun}>{running ? 'Reviewing…' : review ? 'Re-run review' : 'Review working changes'}</button>
        {review ? <span className="review-count">{findings.length} finding{findings.length === 1 ? '' : 's'} · {review.files} file{review.files === 1 ? '' : 's'}</span> : null}
      </div>
      {gate ? <div className={`review-gate gate-${gate.status}`}>{GATE_LABEL[gate.status] ?? gate.status} — {gate.reason}</div> : null}
      {running ? <div className="row status"><span className="spinner" /> Running a local review over the working diff…</div> : null}
      {review && !running ? (
        <>
          {review.summary ? <div className="review-summary">{review.summary}</div> : null}
          {findings.length === 0 ? <div className="empty">No issues found in the working changes. ✓</div> : null}
          {[...byFile.entries()].map(([file, fs]) => (
            <div key={file} className="review-file">
              <div className="review-file-head">
                <span className="rfh-name" title={file}>{file}</span>
                <span className="rfh-count">{fs.length}</span>
              </div>
              {fs.map((f, i) => {
                const resolved = f.status && f.status !== 'open';
                return (
                <div key={f.id ?? i} className={`review-finding${resolved ? ' resolved' : ''}`}>
                  <div className="review-finding-head">
                    <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                    {f.preExisting ? <span className="sev sev-preexisting" title="A bug that already existed here — this change did not introduce it (does not block).">pre-existing</span> : null}
                    {f.line ? <span className="review-line">L{f.line}{f.endLine && f.endLine !== f.line ? `–${f.endLine}` : ''}</span> : null}
                    {resolved ? <span className="finding-status">{f.status}</span> : null}
                    <span className="review-conf">{f.confidence}%</span>
                  </div>
                  <div className="review-finding-body">{f.summary}</div>
                  {f.details ? <div className="review-finding-details">{f.details}</div> : null}
                  <ReviewCodeFrame f={f} />
                  {f.suggestion && !f.diffHunk && !(f.codeExcerpt && /[\n;{}()=]/.test(f.suggestion)) ? (
                    <div className="review-suggestion"><span className="rs-label">Suggested fix</span> {f.suggestion}</div>
                  ) : null}
                  <div className="finding-actions">
                    {!resolved && f.canApply ? <Button variant="primary-ghost" onClick={() => onApply(f)}>Apply suggestion</Button> : null}
                    {!resolved ? <Button onClick={() => onAskFix(f)}>Ask agent to fix</Button> : null}
                    {!resolved ? <Button onClick={() => onDiscuss(f)}>Discuss</Button> : null}
                    {/* §9 — capture this finding as a durable annotation (survives the review run). */}
                    <Button onClick={() => onAnnotate(f)} title="Save this finding as a durable annotation">Annotate</Button>
                    <Button onClick={() => onOpenDiff(f)} title="Open this file's diff">Open diff</Button>
                    <Button onClick={() => onOpenFile(f)} title="Open the file">Open file</Button>
                    {/* ADR-029 C2 — Code → Notes. Only one review run is kept
                        per workspace, so a finding worth returning to has to
                        leave the review to survive the next one; the note keeps
                        the words and cites the file it was about. */}
                    <Button onClick={() => void findingToNote(f)} title="Keep this finding as a note, citing the file">To notes</Button>
                    {!resolved ? <Button onClick={() => onResolve(f)}>Resolve</Button> : null}
                    {!resolved ? <Button onClick={() => onDismiss(f)}>Dismiss</Button> : null}
                    {/* 0.4.15 triage — clear the gate without claiming code changed. */}
                    {!resolved ? <Button title="Seen, accepted as-is" onClick={() => onTriage(f, 'acknowledged')}>Acknowledge</Button> : null}
                    {!resolved ? <Button title="Disagree with this finding" onClick={() => onTriage(f, 'disputed')}>Dispute</Button> : null}
                    {!resolved ? <Button title="Real, but not for this change" onClick={() => onTriage(f, 'out-of-scope')}>Out of scope</Button> : null}
                  </div>
                </div>
                );
              })}
            </div>
          ))}
        </>
      ) : !running ? <div className="empty">Run a review of your uncommitted changes before a commit/PR — findings appear here grouped by file with the exact lines + suggested fix, and commit/push stay blocked until critical/high findings are resolved.</div> : null}
    </div>
  );
}
