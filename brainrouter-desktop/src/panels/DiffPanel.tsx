/**
 * DESK-5j — the Changes panel: the working-tree file list, a per-file diff
 * view, and the commit/push/pull row. Wave 7/§7 — the review gate is surfaced
 * right above the commit row: when it blocks, Commit/Push are disabled and an
 * explicit "without review" bypass appears instead.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import { DiffView } from './diff.js';
import { commitBlocked } from '../lib/review/reviewGateUi.js';
import { GATE_LABEL, type ReviewGateView } from './reviewShared.js';

export function DiffPanel({ gitInfo, changed, diff, onPick, onBack, onOpenFile, onGit, onGitBypass, gitBusy, reviewGate, onReview, findingsByFile }: {
  gitInfo: { repo: string; branch: string | null; insertions: number; deletions: number } | null;
  changed: Array<{ status: string; path: string }>;
  diff: { path: string; diff: string } | null;
  onPick: (path: string) => void;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  /** DESK-5j — the review surface acts on git: commit all / push / pull. */
  onGit?: (kind: 'commit' | 'push' | 'pull', msg?: string) => void;
  /** §7 — explicit bypass (Commit/Push without review) when the gate blocks. */
  onGitBypass?: (kind: 'commit' | 'push', msg?: string) => void;
  gitBusy?: boolean;
  /** Wave 7 — surface the review gate right in the Changes area. */
  reviewGate?: ReviewGateView | null;
  onReview?: () => void;
  /** §4 — count of review findings per file, for the badge next to each file. */
  findingsByFile?: Record<string, number>;
}): React.ReactElement {
  const [msg, setMsg] = useState('');
  const commit = () => { if (msg.trim() && changed.length) { onGit?.('commit', msg.trim()); setMsg(''); } };
  const blocked = commitBlocked(reviewGate, changed.length);
  const reason = reviewGate?.reason ?? '';
  return (
    <>
      {gitInfo?.branch ? (
        <div className="gitbar">
          <span className="gitbranch"><Icon name="branch" size={12} /> {gitInfo.branch}</span>
          {gitInfo.insertions + gitInfo.deletions > 0 ? (
            <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
          ) : <span className="dim">clean</span>}
        </div>
      ) : null}
      {onGit && gitInfo?.branch && !diff ? (
        <>
          {/* §7 — review status + entry point, right above the commit row. */}
          {changed.length && reviewGate ? (
            <div className={`diff-review-status gate-${reviewGate.status}`}>
              <span className="drs-label" title={reason}>{GATE_LABEL[reviewGate.status] ?? reviewGate.status}</span>
              {onReview ? <button className="drs-btn" onClick={onReview}>{reviewGate.status === 'clean' ? 'View review' : reviewGate.status === 'needs-review' ? 'Run review' : 'Open review'}</button> : null}
            </div>
          ) : null}
          <div className="review-actions">
            <input className="filter commit-msg" placeholder={changed.length ? 'Commit message' : 'Working tree clean'}
              value={msg} disabled={!changed.length || gitBusy}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
            {/* §7 — when blocked, the primary Commit/Push are DISABLED (use Run review
                or the explicit bypass below); when clean, they proceed as reviewed. */}
            <button className="btn" disabled={!changed.length || !msg.trim() || gitBusy || blocked} title={blocked ? reason : undefined} onClick={commit}>Commit</button>
            <button className="btn" disabled={gitBusy || blocked} title={blocked ? reason : undefined} onClick={() => onGit('push')}>Push</button>
            <button className="btn" disabled={gitBusy} onClick={() => onGit('pull')}>Pull</button>
          </div>
          {blocked && onGitBypass ? (
            <div className="review-bypass">
              <button className="bypass-btn" disabled={!changed.length || !msg.trim() || gitBusy} onClick={() => { onGitBypass('commit', msg.trim()); setMsg(''); }}>Commit without review</button>
              <button className="bypass-btn" disabled={gitBusy} onClick={() => onGitBypass('push')}>Push without review</button>
            </div>
          ) : null}
        </>
      ) : null}
      {diff ? (
        <>
          <button className="backlink" onClick={onBack}>← {diff.path}</button>
          <div className="scroll">
            <DiffView diff={diff.diff} />
          </div>
        </>
      ) : (
        <div className="scroll">
          {changed.length === 0 ? <div className="empty center-empty">No changes to show</div> : changed.map((f) => {
            const findings = findingsByFile?.[f.path] ?? 0;
            return (
            <div key={f.path} className="file-row" title={f.path}>
              <span className={`fstat s-${f.status.replace('?', 'u')}`}>{f.status}</span>
              <span className="file-name" onClick={() => onPick(f.path)}>{f.path}</span>
              {findings ? <span className="file-findings" title={`${findings} review finding${findings === 1 ? '' : 's'}`}>{findings}</span> : null}
              <button className="icon-btn" title="Open file" onClick={() => onOpenFile(f.path)}><Icon name="file" size={12} /></button>
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}
