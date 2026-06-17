/**
 * T4 — the center column: chat-head breadcrumb, the scrolling transcript
 * (home view / forked banner / rows, or a read-only task-convo / workflow
 * card), the live/working/approval rows, jump-to-latest, the branch bar, and
 * the composer (passed in as a node so its 25-prop wiring stays in App).
 * Extracted verbatim from App.tsx; the App owns all state, refs, and handlers.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import remarkGfm from 'remark-gfm';
import { Markdown, MD_COMPONENTS } from '../chat/markdown.js';
import { WorkflowCard } from '../chat/WorkflowCard.js';
import { HomeView } from './HomeView.js';
import { WorkElapsed } from './WorkElapsed.js';
import type { ChatRow, WorkflowDetail, SessionRow } from '../types.js';
import type { InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { ConfigSnapshot } from '../settings.js';
import type { PanelId } from '../panels/Panel.js';

type GitInfo = { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;
type TaskView = { id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null;
type HomeStats = { sessions: number; turns: number; activeDays: number; currentStreak: number; longestStreak: number; model: string; perDay: Record<string, number> } | null;
type InteractionResponse = { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' };

export interface ChatThreadProps {
  homeMode: boolean;
  railOpen: boolean;
  setRailOpen: Dispatch<SetStateAction<boolean>>;
  gitInfo: GitInfo;
  info: { workspaceRoot?: string; username?: string; model?: string };
  sessionTitle: string;
  taskView: TaskView;
  setTaskView: Dispatch<SetStateAction<TaskView>>;
  chatRef: React.RefObject<HTMLDivElement>;
  atBottomRef: React.MutableRefObject<boolean>;
  setAtBottom: Dispatch<SetStateAction<boolean>>;
  workflowView: WorkflowDetail | null;
  setWorkflowView: Dispatch<SetStateAction<WorkflowDetail | null>>;
  renderRow: (r: ChatRow, liveLast: boolean) => React.ReactElement;
  homeStats: HomeStats;
  statsTab: 'overview' | 'models';
  setStatsTab: Dispatch<SetStateAction<'overview' | 'models'>>;
  statsRange: 'all' | '30d' | '7d';
  setStatsRange: Dispatch<SetStateAction<'all' | '30d' | '7d'>>;
  snapshot: ConfigSnapshot | null;
  sessions: SessionRow[];
  resumeSession: (key: string) => void;
  forkParent: { key: string; title?: string } | null;
  transcriptEls: React.ReactElement[];
  liveText: string;
  running: boolean;
  turnStart: number;
  reasoningTail: string;
  statusLine: string;
  interaction: InteractionRequest | null;
  answerInteraction: (response: InteractionResponse) => void;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  chatEnd: React.RefObject<HTMLDivElement>;
  atBottom: boolean;
  hasConversation: boolean;
  changedFiles: Array<{ status: string; path: string }>;
  ensurePanel: (id: PanelId) => void;
  composer: React.ReactNode;
}

export function ChatThread(p: ChatThreadProps): React.ReactElement {
  const {
    homeMode, railOpen, setRailOpen, gitInfo, info, sessionTitle, taskView, setTaskView, chatRef, atBottomRef,
    setAtBottom, workflowView, setWorkflowView, renderRow, homeStats, statsTab, setStatsTab, statsRange, setStatsRange,
    snapshot, sessions, resumeSession, forkParent, transcriptEls, liveText, running, turnStart, reasoningTail,
    statusLine, interaction, answerInteraction, q, chatEnd, atBottom, hasConversation, changedFiles, ensurePanel, composer,
  } = p;
  return (
    <main className={`center${homeMode ? ' home-mode' : ''}${railOpen ? '' : ' no-rail'}`}>
      <header className="chat-head">
        {!railOpen ? <button className="icon-btn" title="Open sidebar" onClick={() => setRailOpen(true)}><Icon name="layout" size={15} /></button> : null}
        <span className="crumb">
          <b>{gitInfo?.repo ?? info.workspaceRoot?.split('/').pop() ?? 'BrainRouter'}</b>
          <span className="crumb-sep">/</span>
          {taskView ? (
            /* DESK-6v — viewing a sub-agent: ONE breadcrumb (no second header
               bar). The parent session is clickable = back. */
            <>
              <button className="crumb-link" onClick={() => setTaskView(null)}>{sessionTitle}</button>
              <span className="crumb-sep">/</span>
              <span className="crumb-cur">{taskView.role || taskView.kind}</span>
              {taskView.status ? <span className={`task-status ${taskView.status}`}>{taskView.status}</span> : null}
            </>
          ) : sessionTitle}
        </span>
      </header>
      <div className="chat" ref={chatRef} onScroll={() => {
        const el = chatRef.current;
        if (!el) return;
        const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        atBottomRef.current = pinned;
        setAtBottom(pinned);
      }}>
        {workflowView ? (
          /* DESK-6w — the /workflows-style card for a workflow run. */
          <WorkflowCard wf={workflowView} onBack={() => setWorkflowView(null)} />
        ) : taskView ? (
          /* DESK-6v — a background task's conversation, read-only, in place
             of the chat. The header breadcrumb (Repo / Session / Role +
             status) now carries the title and back-link, so there's no
             second header bar here — that double header was the confusing
             part. The prompt is already the first user bubble. */
          <div className="task-convo">
            {taskView.rows.map((r) => renderRow(r, false))}
          </div>
        ) : (
          <>
            {homeMode ? (
              <HomeView username={info.username} stats={homeStats} tab={statsTab} setTab={setStatsTab}
                range={statsRange} setRange={setStatsRange} model={info.model} provider={snapshot?.provider}
                repo={gitInfo?.repo ?? info.workspaceRoot?.split('/').pop()}
                recents={sessions}
                onResume={(key) => resumeSession(key)} />
            ) : null}
            {!homeMode && forkParent ? (
              <button className="fork-banner" onClick={() => resumeSession(forkParent.key)}
                title="Open the original conversation this was forked from">
                <Icon name="branch" size={12} />
                <span>Forked from <strong>{forkParent.title || 'conversation'}</strong></span>
              </button>
            ) : null}
            {transcriptEls}
          </>
        )}
        {!taskView && !workflowView && liveText ? (
          <div className="row assistant md live">
            <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{liveText}</Markdown>
            <span className="caret">▍</span>
          </div>
        ) : null}
        {!taskView && !workflowView && running ? (
          <div className="row workline">
            <span className="spinner sm" />
            <WorkElapsed startedAt={turnStart} />
            <span>·</span>
            <span>{liveText ? 'writing…' : reasoningTail ? 'thinking…' : statusLine || 'working…'}</span>
            {reasoningTail && !liveText ? <span className="reasoning"> {reasoningTail.slice(-90)}</span> : null}
          </div>
        ) : null}
        {!taskView && !workflowView && interaction && interaction.type === 'confirm' ? (
          <div className="approval-card" onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) answerInteraction({ type: 'confirm', approved: true });
          }}>
            <div className="approval-head">
              <span className="approval-dot" />
              <span className="approval-title">{interaction.title}</span>
              <span className="approval-scope">Project (local)</span>
            </div>
            {interaction.tool ? <div className="approval-sub">{interaction.tool}</div> : null}
            {interaction.dangerous ? <div className="approval-warn">This action is flagged as potentially dangerous.</div> : null}
            {interaction.detail ? <pre className="approval-detail">{interaction.detail}</pre> : null}
            <div className="approval-actions">
              <button className="btn-deny" onClick={() => answerInteraction({ type: 'confirm', approved: false })}>Deny</button>
              <span className="spacer" />
              <button className="btn-always" onClick={() => {
                const rule = `${interaction.tool ?? 'run_command'}(*)`;
                q('a-allow-rule', 'action:allow-rule', { rule });
                answerInteraction({ type: 'confirm', approved: true });
              }}>Always allow</button>
              <button className="btn-once" autoFocus onClick={() => answerInteraction({ type: 'confirm', approved: true })}>Allow once<kbd>Ctrl+⏎</kbd></button>
            </div>
          </div>
        ) : null}
        <div ref={chatEnd} />
      </div>
      {hasConversation && !atBottom ? (
        <button className="jump-latest" onClick={() => {
          atBottomRef.current = true;
          setAtBottom(true);
          chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
        }}>↓ Latest</button>
      ) : null}
      {hasConversation && gitInfo?.branch && (gitInfo.insertions + gitInfo.deletions > 0) ? (
        <div className="branchbar" onClick={() => ensurePanel('diff')}>
          <Icon name="diff" size={12} />
          <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
          <span className="dim">{changedFiles.length} files changed — view diff</span>
        </div>
      ) : null}
      {composer}
    </main>
  );
}
