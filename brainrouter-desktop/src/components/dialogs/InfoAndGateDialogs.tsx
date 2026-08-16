/**
 * T4 — trailing overlays: the generic info dialog, the review-gate block
 * dialog (commit/push refused until review is clean, with explicit bypass),
 * and the completion toast. Extracted verbatim from App.tsx; the App owns the
 * git/review state + handlers and passes them through.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import { setEntry } from '../../lib/review/reviewWorkspace.js';
import type { ReviewFindingView, PanelId } from '../../panels/index.js';

type ReviewView = { findings: ReviewFindingView[]; summary: string; files: number };
type GateBlock = { kind: 'commit' | 'push'; msg?: string; reason: string; status: string };

export interface InfoAndGateDialogsProps {
  infoDialog: { title: string; body: string } | null;
  setInfoDialog: Dispatch<SetStateAction<{ title: string; body: string } | null>>;
  gateBlock: GateBlock | null;
  setGateBlock: Dispatch<SetStateAction<GateBlock | null>>;
  activeRoot: string;
  ensurePanel: (id: PanelId) => void;
  setReviewRunningByWs: Dispatch<SetStateAction<Record<string, boolean>>>;
  setReviewByWs: Dispatch<SetStateAction<Record<string, ReviewView | null>>>;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  pendingGitRef: React.MutableRefObject<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>;
  runGit: (kind: 'commit' | 'push' | 'pull', msg?: string, opts?: { bypass?: boolean; reviewed?: boolean }) => void;
  setToast: (v: string) => void;
  setGitBusy: Dispatch<SetStateAction<boolean>>;
  toast: string;
}

export function InfoAndGateDialogs(p: InfoAndGateDialogsProps): React.ReactElement {
  const { infoDialog, setInfoDialog, gateBlock, setGateBlock, activeRoot, ensurePanel, setReviewRunningByWs, setReviewByWs, q, pendingGitRef, runGit, setToast, setGitBusy, toast } = p;
  return (
    <>
      {infoDialog ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setInfoDialog(null); }}>
          <div className="dialog">
            <div className="dialog-title">{infoDialog.title}</div>
            <pre className="dialog-detail">{infoDialog.body}</pre>
            <div className="dialog-actions">
              <button className="deny" onClick={() => setInfoDialog(null)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
      {/* Wave 4 — review gate block: commit/push refused until review is clean. */}
      {gateBlock ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setGateBlock(null); }}>
          <div className="dialog">
            <div className="dialog-title"><Icon name="shield" size={15} /> Review required before {gateBlock.kind}</div>
            <div className="dialog-detail">{gateBlock.reason}</div>
            <div className="dialog-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="primary" onClick={() => { const g = gateBlock; setGateBlock(null); ensurePanel('stack'); if (g.status !== 'blocked') { setReviewRunningByWs((m) => ({ ...m, [activeRoot]: true })); setReviewByWs((m) => setEntry(m, activeRoot, null)); q('q-review-diff', 'review-diff'); } }}>
                {gateBlock.status === 'blocked' ? 'Open review' : 'Run review'}
              </button>
              <button className="deny" onClick={() => { const g = gateBlock; setGateBlock(null); pendingGitRef.current = null; runGit(g.kind, g.msg, { bypass: true }); setToast(`${g.kind === 'commit' ? 'Commit' : 'Push'} — review bypassed.`); }}>
                {gateBlock.kind === 'commit' ? 'Commit without review' : 'Push without review'}
              </button>
              <button className="deny" onClick={() => { setGateBlock(null); pendingGitRef.current = null; setGitBusy(false); }}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}
