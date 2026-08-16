/**
 * T4 — the center column: chat-head breadcrumb, the scrolling transcript
 * (home view / forked banner / rows, or a read-only task-convo / workflow
 * card), the live/working/approval rows, jump-to-latest, the branch bar, and
 * the composer (passed in as a node so its 25-prop wiring stays in App).
 * Extracted verbatim from App.tsx; the App owns all state, refs, and handlers.
 */
import type { WorkspaceMode } from '../layout/ActivityBar.js';
import React, { useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import remarkGfm from 'remark-gfm';
import { Markdown, MD_COMPONENTS } from '../../chat/markdown.js';
import { WorkflowCard } from '../../chat/WorkflowCard.js';
import { ChangeSummary } from '../../chat/ChangeSummary.js';
import { HomeView } from './HomeView.js';
import { WorkElapsed } from '../status/WorkElapsed.js';
import { GoalBanner, type GoalRecord } from './GoalBanner.js';
import type { ChatRow, TaskViewState, WorkflowDetail, SessionRow } from '../../types.js';
import type { InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { ConfigSnapshot } from '../../settings.js';
import type { PanelId } from '../../panels/Panel.js';

type GitInfo = { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;
type TaskView = TaskViewState | null;
type HomeStats = { sessions: number; turns: number; activeDays: number; currentStreak: number; longestStreak: number; model: string; perDay: Record<string, number> } | null;
type InteractionResponse = { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' };

export interface ChatThreadProps {
  homeMode: boolean;
  onMode: (mode: WorkspaceMode) => void;
  onStartBuild: () => void;
  onOpenHomeView: (id: PanelId) => void;
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
  // header rename — the current session key + a title writer. The edit UI lives
  // in ChatThread's OWN local state (NOT the sidebar's shared renamingKey) so the
  // header input and the sidebar's active-row input can never both autofocus and
  // fight for focus (the loser's onBlur used to commit and exit instantly).
  viewKey: string;
  onRenameCurrent: (title: string) => void;
  resumeSession: (key: string) => void;
  forkParent: { key: string; title?: string } | null;
  goal: GoalRecord | null;
  onGoalResume: () => void;
  onGoalPause: () => void;
  onGoalClear: () => void;
  onGoalEdit: (text: string) => void;
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
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const {
    homeMode, onMode, onStartBuild, onOpenHomeView, railOpen, setRailOpen, gitInfo, info, sessionTitle, chatRef, atBottomRef,
    setAtBottom, workflowView, setWorkflowView, homeStats, statsTab, setStatsTab, statsRange, setStatsRange,
    snapshot, sessions, viewKey, onRenameCurrent,
    resumeSession, forkParent, transcriptEls, liveText, running, turnStart, reasoningTail,
    statusLine, interaction, answerInteraction, q, chatEnd, atBottom, hasConversation, changedFiles, ensurePanel, composer,
  } = p;
  // header rename — show the CURRENT session's listed title (the host overrides
  // it with a custom rename: host.ts `m.title || s.firstUserMessage`), falling
  // back to the derived sessionTitle for a brand-new chat.
  const currentRow = sessions.find((s) => s.sessionKey === viewKey);
  const headerTitle = currentRow?.firstUserMessage?.trim() || sessionTitle;
  // LOCAL edit state (independent of the sidebar's renamingKey). titleEditDoneRef
  // swallows the trailing unmount-blur so Enter/Escape can't fire a second time.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleEditDoneRef = React.useRef(false);
  const beginTitleEdit = (): void => { if (!currentRow) return; titleEditDoneRef.current = false; setTitleDraft(headerTitle); setEditingTitle(true); };
  const finishTitleEdit = (save: boolean): void => {
    if (titleEditDoneRef.current) return;
    titleEditDoneRef.current = true;
    setEditingTitle(false);
    if (save) { const t = titleDraft.trim(); if (t && t !== headerTitle) onRenameCurrent(t); }
  };
  // K-desktop — OPT-IN "Sync to cloud": mirror THIS session's user/assistant
  // turns up to the shared chat-threads API so the conversation also shows on
  // the dashboard + CLI. Local transcripts are untouched; this only runs on an
  // explicit click, never on a normal chat turn.
  const activeRoot = info.workspaceRoot;
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [syncNote, setSyncNote] = useState('');
  React.useEffect(() => { setSyncState('idle'); setSyncNote(''); }, [viewKey]);
  const syncToCloud = async (): Promise<void> => {
    if (!activeRoot || !currentRow || syncState === 'syncing') return;
    const api = window.brainrouter.chatSync;
    if (!api) { setSyncState('failed'); setSyncNote('Chat sync is unavailable in this build.'); return; }
    setSyncState('syncing');
    setSyncNote('');
    try {
      const res = await api.push({ workspaceRoot: activeRoot, sessionKey: viewKey, title: headerTitle });
      setSyncState('synced');
      setSyncNote(`Synced ${res.messageCount} message${res.messageCount === 1 ? '' : 's'} to the cloud.`);
    } catch (err) {
      setSyncState('failed');
      setSyncNote(err instanceof Error ? err.message : 'Could not sync this chat.');
    }
  };
  const syncLabel = syncState === 'syncing' ? 'Syncing…'
    : syncState === 'synced' ? 'Synced'
    : syncState === 'failed' ? 'Retry sync'
    : 'Sync to cloud';
  return (
    <main className={`center${homeMode ? ' home-mode' : ''}${railOpen ? '' : ' no-rail'}`}>
      <header className="chat-head">
        {!railOpen ? <button className="icon-btn chat-rail-open" title="Open sidebar" aria-label="Open sidebar" onClick={() => setRailOpen(true)}><Icon name="layout" size={15} /></button> : null}
        <span className="crumb">
          <b>{gitInfo?.repo ?? info.workspaceRoot?.split('/').pop() ?? 'BrainRouter'}</b>
          <span className="crumb-sep">/</span>
          {editingTitle ? (
            <input className="session-rename" autoFocus value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finishTitleEdit(true); } else if (e.key === 'Escape') { e.preventDefault(); finishTitleEdit(false); } }}
              onBlur={() => finishTitleEdit(true)} />
          ) : (
            <button type="button" className="crumb-cur crumb-link"
              title={currentRow ? 'Rename chat' : undefined}
              onClick={beginTitleEdit}
              disabled={!currentRow}>
              {headerTitle}
            </button>
          )}
        </span>
        {!homeMode && currentRow ? (
          <button type="button"
            className={`chat-sync-btn${syncState === 'synced' ? ' synced' : ''}${syncState === 'failed' ? ' failed' : ''}`}
            onClick={syncToCloud}
            disabled={syncState === 'syncing'}
            title={syncNote || 'Sync this chat to the cloud so it appears on the dashboard and CLI'}
            aria-label="Sync this chat to the cloud">
            {syncState === 'syncing'
              ? <span className="spinner sm" />
              : <Icon name={syncState === 'synced' ? 'check-circle' : 'globe'} size={13} />}
            <span>{syncLabel}</span>
          </button>
        ) : null}
      </header>
      <div className="chat" ref={chatRef} onScroll={() => {
        const el = chatRef.current;
        if (!el) return;
        const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        atBottomRef.current = pinned;
        setAtBottom(pinned);
      }}>
        {/* GOAL-BANNER — pinned at the top of the chat for the active /goal,
            sticky so it stays visible while scrolling. Hidden in the home view. */}
        {p.goal && !p.homeMode ? (
          <GoalBanner goal={p.goal} onResume={p.onGoalResume} onPause={p.onGoalPause} onClear={p.onGoalClear} onEdit={p.onGoalEdit} />
        ) : null}
        {workflowView ? (
          /* DESK-6w — the /workflows-style card for a workflow run. */
          <WorkflowCard wf={workflowView} onBack={() => setWorkflowView(null)} />
        ) : (
          <>
            {homeMode ? (
              <HomeView username={info.username} stats={homeStats} tab={statsTab} setTab={setStatsTab}
                range={statsRange} setRange={setStatsRange} model={info.model} provider={snapshot?.provider}
                repo={gitInfo?.repo ?? info.workspaceRoot?.split('/').pop()}
                recents={sessions}
                onResume={(key) => resumeSession(key)} onMode={onMode} onStartBuild={onStartBuild} onOpenView={onOpenHomeView} />
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
        {!workflowView && liveText ? (
          <div className="row assistant md live">
            <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{liveText}</Markdown>
            <span className="caret">▍</span>
          </div>
        ) : null}
        {!workflowView && running ? (
          <div className="row workline-container">
            <div className="workline-header">
              <span className="spinner sm" />
              <WorkElapsed startedAt={turnStart} />
              <span className="dot-sep">·</span>
              {reasoningTail && !liveText ? (
                <span className="status-label">thinking…</span>
              ) : (
                <span className="status-label">{liveText ? 'writing…' : statusLine || 'working…'}</span>
              )}
            </div>

            {reasoningTail && !liveText ? (
              <details
                className="workline-think"
                open={reasoningExpanded}
                onToggle={(e) => setReasoningExpanded((e.target as HTMLDetailsElement).open)}
              >
                <summary>
                  {!reasoningExpanded ? (
                    <span className="reasoning-preview">
                      {reasoningTail.slice(-90)}
                    </span>
                  ) : (
                    <span className="reasoning-toggle-hint">Click to collapse thinking</span>
                  )}
                </summary>
                <div className="reasoning-full-box">
                  <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{reasoningTail}</Markdown>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
        {!workflowView && interaction && interaction.type === 'confirm' ? (
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
      {hasConversation ? <ChangeSummary gitInfo={gitInfo} changedFiles={changedFiles} ensurePanel={ensurePanel} q={q} /> : null}
      {composer}
    </main>
  );
}
