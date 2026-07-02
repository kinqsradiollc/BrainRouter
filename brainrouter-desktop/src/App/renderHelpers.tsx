/**
 * App shell — the two per-row render helpers: a sidebar chat-node (with its
 * status icon, inline rename, and ⋮ menu) and one transcript MessageRow. Both
 * are moved verbatim from App.tsx via `build*` closures so the composed shell
 * can pass them as props unchanged (the rendered output is identical).
 */
import React from 'react';
import { Icon } from '../icons.js';
import { MessageRow } from '../chat/MessageRow.js';
import { SessionStatus, PrStatusIcon } from '../components/SessionStatus.js';
import { prStatusFor } from '../lib/ci/prStatus.js';
import { fmtAge } from '../lib/format.js';
import type { ChatRow, SessionRow } from '../types.js';
import type { PanelId } from '../panels/index.js';
import type { useCi } from '../lib/ci/useCi.js';

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

export interface RenderSessionNodeCtx {
  runningSessions: string[];
  ci: ReturnType<typeof useCi>;
  viewKey: string;
  sessionMenu: { key: string } | null;
  openSessionMenu: (e: React.MouseEvent, key: string) => void;
  renamingKey: string | null;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  commitRename: () => void;
  setRenamingKey: (v: string | null) => void;
  resumeSession: (key: string) => void;
  dupeTitleKeys: Set<string>;
}

export function buildRenderSessionNode(ctx: RenderSessionNodeCtx): (s: SessionRow, i: number) => React.ReactElement {
  const {
    runningSessions, ci, viewKey, sessionMenu, openSessionMenu, renamingKey, renameDraft, setRenameDraft,
    commitRename, setRenamingKey, resumeSession, dupeTitleKeys,
  } = ctx;
  // DESK-6m — one chat row with its ⋮ menu trigger + pinned/completed state +
  // inline rename. Background tasks are not rendered as chats.
  return (s: SessionRow, i: number): React.ReactElement => {
    const running = runningSessions.includes(s.sessionKey);
    // §session-pr — match the session's branch to its PR (skipped while a turn
    // runs; the running spinner takes priority over the PR icon).
    const pr = running ? null : prStatusFor(s.branch, ci.prByBranch);
    return (
    <React.Fragment key={s.sessionKey}>
      <div className={`session-wrap${s.sessionKey === viewKey ? ' active' : ''}${s.status === 'completed' ? ' completed' : ''}${sessionMenu?.key === s.sessionKey ? ' menu-open' : ''}`}
        onContextMenu={(e) => openSessionMenu(e, s.sessionKey)}>
        {renamingKey === s.sessionKey ? (
          <input className="session-rename" autoFocus value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingKey(null); }}
            onBlur={commitRename} />
        ) : (
          <button className="project-session" title={s.firstUserMessage || s.sessionKey}
            onClick={() => resumeSession(s.sessionKey)}>
            {s.pinned ? <span className="st st-pin" title="Pinned"><Icon name="pin" size={11} /></span>
              : (s.forkedFrom && !running)
                ? <span className="st st-fork" title="Forked conversation"><Icon name="branch" size={11} /></span>
                : pr
                  ? <PrStatusIcon status={pr.status} pr={pr.pr} />
                  : <SessionStatus s={s} working={running} />}
            <span className="session-title">
              {s.firstUserMessage || s.sessionKey}
              {dupeTitleKeys.has(s.sessionKey) && s.modifiedAt ? <span className="title-age"> · {fmtAge(s.modifiedAt)}</span> : null}
            </span>
            {s.status === 'completed' ? <span className="session-done" title="Completed"><Icon name="check-circle" size={11} /></span> : null}
            {!s.group && i < 9 ? <span className="session-cmd">⌘{i + 1}</span> : null}
            {s.modifiedAt && !dupeTitleKeys.has(s.sessionKey) ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
          </button>
        )}
        <button className="session-menu-btn icon-btn" aria-label="Chat options" onClick={(e) => openSessionMenu(e, s.sessionKey)}><Icon name="dots" size={13} /></button>
      </div>
    </React.Fragment>
    );
  };
}

export interface RenderRowCtx {
  q: Query;
  inlineDiffs: Record<string, string>;
  openFile: (f: string) => void;
  setDiffTarget: (t: { path: string; line?: number } | null) => void;
  ensurePanel: (id: PanelId) => void;
  setRows: (val: ChatRow[] | ((prev: ChatRow[]) => ChatRow[])) => void;
  errorsBySession: React.MutableRefObject<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>;
  forkSessionAction: (sessionKey: string, ts: number) => void;
  sessionKeyRef: React.MutableRefObject<string | undefined>;
}

export function buildRenderRow(ctx: RenderRowCtx): (r: ChatRow, liveLast: boolean) => React.ReactElement {
  const { q, inlineDiffs, openFile, setDiffTarget, ensurePanel, setRows, errorsBySession, forkSessionAction, sessionKeyRef } = ctx;
  // DESK-5w (#4 lag) — render ONE transcript row. Extracted + memoized (in the
  // shell) so streaming deltas / the per-second tick don't re-render the whole
  // history (every <Markdown> was re-parsing on every ~18ms delta — the lag).
  return (r: ChatRow, liveLast: boolean): React.ReactElement => (
    <MessageRow
      key={r.id}
      r={r}
      liveLast={liveLast}
      inlineDiffs={inlineDiffs}
      onRequestDiff={(f) => q('q-inline-diff', 'file-diff', { path: f })}
      onOpenFile={(f) => openFile(f)}
      onOpenDiff={(f) => { setDiffTarget({ path: f, line: 1 }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: f }); }}
      onOpenPlan={() => ensurePanel('plan')}
      onDismissError={(id) => {
        setRows((rs) => rs.filter((x) => x.id !== id));
        for (const k of Object.keys(errorsBySession.current)) errorsBySession.current[k] = errorsBySession.current[k].filter((er) => er.id !== id);
      }}
      onFork={(ts) => forkSessionAction(sessionKeyRef.current ?? '', ts)}
      onRewind={(ts) => q('a-rewind', 'action:rewind-to', { ts })}
    />
  );
}
