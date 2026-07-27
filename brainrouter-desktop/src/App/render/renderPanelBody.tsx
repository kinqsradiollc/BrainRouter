/**
 * App shell — the side/dock panel body renderer. `buildRenderPanelBody(ctx)`
 * returns the `renderPanelBody(id)` function used by both <ViewsRail/> and the
 * <TerminalDock/>. The switch bodies are moved verbatim from App.tsx; every
 * value they close over is passed on `ctx` so the rendered output is unchanged.
 */
import React, { Suspense, lazy } from 'react';
import {
  DiffPanel, FilesPanel, FileViewerPanel, PlanPanel, SearchPanel, SchedulePanel, WorktreesPanel, ReviewPanel,
  RequirementsPanel, AnnotationsPanel, ArtifactsPanel, AttachmentsPanel, AtlasPanel, WorkflowsPanel, MemoryPanel, KnowledgePanel, PrototypePanel, TasksPanel, TaskDetailPanel, TerminalPanel, ToolsPanel, ServersPanel, ContextPanel, type PanelId, type SearchHit, type ReviewFindingView, type GrepHit, type FinishedTask,
} from '../../panels/index.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord, AtlasGraph } from '@kinqs/brainrouter-types';
import type { TrackPrStatus } from '../../track/TrackView.js';
import type { ScheduleRecordView } from '../../lib/schedule/scheduleView.js';
import { setEntry } from '../../lib/review/reviewWorkspace.js';
import type { PlanItem, FleetRow, TaskViewState, ChatRow } from '../../types.js';
import type { PlanDecisionView } from '../../lib/plan/planReviewView.js';
import type { GitState } from '../../lib/git/useGitState.js';
import type { useEditor } from '../../lib/editor/useEditor.js';
import type { useCi } from '../../lib/ci/useCi.js';
import { type DashTab, type DashTask, type WorkspaceDash } from '../../lib/workspace/dashboard.js';
import type { AtlasChangeAssessment } from '../../lib/atlas/atlasView.js';
import { buildTrackOps } from '../track/trackOps.js';
// UI-TEST fusion — the Atlas Screens map + user-journey stories the Atlas panel
// renders, and the Browser panel that replays them live.
import type { UiMap, Story } from '@kinqs/brainrouter-core/browser';

// Monaco is ~5MB — lazy-load the editor panel so it only loads when first opened.
const EditorPanel = lazy(() => import('../../panels/editing/EditorPanel.js').then((m) => ({ default: m.EditorPanel })));
// CI is an optional panel rarely opened on load — lazy so it stays out of the
// initial bundle / first paint.
const CIPanel = lazy(() => import('../../panels/ci/CIPanel.js').then((m) => ({ default: m.CIPanel })));
// UI-TEST fusion — the embedded Browser panel (webview + tool rail) is only
// opened for UI testing; lazy so its webview bridge stays out of first paint.
const BrowserPanel = lazy(() => import('../../panels/BrowserPanel.js').then((m) => ({ default: m.BrowserPanel })));

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

export interface RenderPanelBodyCtx {
  q: Query;
  hostUp: boolean;
  running: boolean;
  info: { sessionKey?: string; model?: string; workspaceRoot?: string; username?: string };
  gitInfo: GitState['gitInfo'];
  branches: { current: string | null; branches: string[]; loading?: boolean };
  tokens: { promptTokens: number; completionTokens: number; turns: number; cachedTokens?: number } | null;
  liveTurn: { promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number } | null;
  contextUsage: { used: number; window: number; compactAt: number; limit: number; pct: number } | null;
  efficiency: { compactions: number; droppedMessages: number; memoriesRecalled: number };
  runningTasks: FleetRow[];
  allFiles: GitState['allFiles'];
  statuses: Map<string, string>;
  openFile: (f: string) => void;
  grepHits: GrepHit[] | null;
  filesLoading: boolean;
  filesTruncated: boolean;
  filesError: string;
  fileView: GitState['fileView'];
  editor: ReturnType<typeof useEditor>;
  closeEditorTab: (path: string) => void;
  openUrl: (url: string) => void;
  setToast: (t: string) => void;
  ci: ReturnType<typeof useCi>;
  reviewPrWithAi: (pr: { number: number; title?: string; headRefName?: string; baseRefName?: string }) => void;
  track: { pr: TrackPrStatus | null };
  trackOps: ReturnType<typeof buildTrackOps>;
  changedFiles: GitState['changedFiles'];
  diffView: GitState['diffView'];
  diffTarget: GitState['diffTarget'];
  setDiffTarget: GitState['setDiffTarget'];
  ensurePanel: (id: PanelId) => void;
  setDiffView: GitState['setDiffView'];
  runGit: GitState['runGit'];
  gitBusy: boolean;
  reviewGate: GitState['reviewGate'];
  reviewFindingsByFile: GitState['reviewFindingsByFile'];
  toolLog: Array<{ id: number; tool: string; ok: boolean; summary: string }>;
  backgroundTasks: FleetRow[];
  recentTasks: FleetRow[];
  finishedTasks: FinishedTask[];
  setFinishedTasks: (v: FinishedTask[]) => void;
  openTask: (f: FleetRow) => void;
  submit: (prompt: string) => void;
  taskView: TaskViewState | null;
  setTaskView: React.Dispatch<React.SetStateAction<TaskViewState | null>>;
  renderRow: (row: ChatRow, isLast: boolean) => React.ReactElement;
  requestStop: () => void;
  closeSideTab: (id: PanelId) => void;
  dashScope: 'workspace' | 'all';
  setDashScope: (s: 'workspace' | 'all') => void;
  refreshDashboard: () => void;
  dashTab: DashTab;
  setDashTab: (t: DashTab) => void;
  dashBoards: WorkspaceDash[];
  dashBusy: boolean;
  openDashboardTask: (t: DashTask) => void;
  switchToWorkspace: (root: string) => void;
  activeRoot: string;
  lastPlan: { items: PlanItem[]; explanation?: string } | null;
  planHistory: PlanDecisionView[];
  planFeedbackRef: React.MutableRefObject<string>;
  searchHits: SearchHit[] | null;
  schedules: ScheduleRecordView[];
  worktrees: GitState['worktrees'];
  worktreeDiffs: GitState['worktreeDiffs'];
  openWorktree: (path: string) => void;
  review: GitState['review'];
  reviewRunning: boolean;
  setReviewRunningByWs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setReviewByWs: GitState['setReviewByWs'];
  setDraft: (d: string) => void;
  atlasGraph: AtlasGraph | null;
  atlasBuilding: boolean;
  atlasEnriching: boolean;
  atlasAssessments: Record<string, AtlasChangeAssessment>;
  atlasAssessing: string | null;
  setAtlasBuilding: (v: boolean) => void;
  setAtlasEnriching: (v: boolean) => void;
  setAtlasAssessing: (v: string | null) => void;
  atlasUiMap: UiMap | null;
  atlasStories: Story[];
  runStory: (story: Story) => void;
  requirements: RequirementRecord[];
  annotations: AnnotationRecord[];
  artifacts: ArtifactRecord[];
}

export function buildRenderPanelBody(ctx: RenderPanelBodyCtx): (id: PanelId, active?: boolean) => React.ReactElement | null {
  const {
    q, hostUp, running, info, gitInfo, branches, tokens, liveTurn, contextUsage, efficiency, runningTasks,
    allFiles, statuses, openFile, grepHits, filesLoading, filesTruncated, filesError, fileView, editor,
    closeEditorTab, openUrl, setToast, ci, reviewPrWithAi, track, trackOps, changedFiles, diffView, diffTarget,
    setDiffTarget, ensurePanel, setDiffView, runGit, gitBusy, reviewGate, reviewFindingsByFile, toolLog,
    submit, taskView, setTaskView, renderRow,
    requestStop, closeSideTab, dashScope, setDashScope,
    refreshDashboard, dashTab, setDashTab, dashBoards, dashBusy, openDashboardTask, switchToWorkspace, activeRoot,
    lastPlan, planHistory, planFeedbackRef, searchHits, schedules, worktrees, worktreeDiffs, openWorktree,
    review, reviewRunning, setReviewRunningByWs, setReviewByWs, setDraft, atlasGraph, atlasBuilding, atlasEnriching,
    atlasAssessments, atlasAssessing, setAtlasBuilding, setAtlasEnriching, setAtlasAssessing, requirements,
    annotations, artifacts, atlasUiMap, atlasStories, runStory,
  } = ctx;

  // DESK-5f — tab CONTENT only; the tab strip owns titles and closing.
  const renderPanelBody = (id: PanelId, active = true): React.ReactElement | null => {
    switch (id) {
      case 'context': return (
        <ContextPanel
          hostUp={hostUp} running={running}
          model={info.model} workspaceRoot={info.workspaceRoot} sessionKey={info.sessionKey}
          gitInfo={gitInfo} branch={branches.current}
          tokens={tokens} liveTurn={liveTurn} contextUsage={contextUsage} efficiency={efficiency}
          bgCount={runningTasks.length} configDir="~/.config/brainrouter"
        />);
      case 'files': return <FilesPanel workspaceKey={activeRoot} files={allFiles} statuses={statuses} onOpen={openFile} grepHits={grepHits}
        onGrep={(gq) => q('q-grep', 'search-content', { q: gq })}
        onRefresh={() => { q('q-list', 'list-files', { refresh: true }); q('q-files', 'changed-files'); }}
        loading={filesLoading} truncated={filesTruncated} error={filesError} />;
      case 'file': return <FileViewerPanel view={fileView} />;
      case 'editor': return (
        <Suspense fallback={<div className="row status"><span className="spinner" /> Loading editor…</div>}>
          <EditorPanel
            workspaceKey={activeRoot} files={allFiles} fileStatuses={statuses} filesLoading={filesLoading}
            tabs={editor.tabs} activePath={editor.activePath} conflictPaths={editor.conflictPaths} saving={editor.saving} revealLine={editor.revealLine}
            onSelect={editor.select} onChange={editor.change} onSave={editor.save} onSaveAll={editor.saveAll}
            onRevert={editor.revert} onClose={closeEditorTab} onReorder={editor.reorder}
            onOpenFile={(f) => openFile(f)} onOpenUrl={openUrl}
            onRefreshFiles={() => { q('q-list', 'list-files', { refresh: true }); q('q-files', 'changed-files'); }}
            onAnnotateSelection={(path, body, anchor) => {
              q('q-annot-create', 'annotation-create', {
                type: 'file',
                body,
                anchor: { filePath: path, startLine: anchor.startLine, endLine: anchor.endLine, selectedText: anchor.selectedText },
              });
              setTimeout(() => q('q-annot', 'annotation-list'), 150);
              setToast('Selected code saved as an annotation.');
            }} />
        </Suspense>
      );
      case 'ci': return <Suspense fallback={<div className="row status"><span className="spinner" /> Loading…</div>}><CIPanel ci={ci} onOpenExternal={openUrl} onReviewPr={reviewPrWithAi} trackPr={track.pr} trackOps={trackOps} /></Suspense>;
      case 'diff': return (
        <DiffPanel gitInfo={gitInfo} changed={changedFiles} diff={diffView}
          scrollToLine={diffView && diffTarget && diffView.path === diffTarget.path ? diffTarget.line : undefined}
          onPick={(p) => { setDiffTarget(null); q('q-diff', 'file-diff', { path: p }); }}
          onBack={() => { setDiffTarget(null); setDiffView(null); }} onOpenFile={openFile}
          onGit={runGit} onGitBypass={(kind, msg) => runGit(kind, msg, { bypass: true })} gitBusy={gitBusy}
          reviewGate={reviewGate} onReview={() => ensurePanel('review')}
          findingsByFile={reviewFindingsByFile} />);
      case 'terminal': return <TerminalPanel />;
      case 'tools': return <ToolsPanel log={toolLog} />;
      // SERVERS — start/stop launch.json dev servers; "Open in Browser" drives the
      // IN-APP Browser panel (not the system browser) via the br-browser-navigate
      // event, mirroring the Atlas onDriveElement handoff.
      case 'servers': return <ServersPanel onOpenInBrowser={(url) => {
        ensurePanel('browser');
        window.dispatchEvent(new CustomEvent('br-browser-navigate', { detail: { url } }));
      }} />;
      // Unified Tasks panel — suggested starters + the (former Dashboard) task
      // board: scope toggle, lifecycle/kind tabs, cross-workspace grouping. A row
      // click opens the task read-only in the Task side panel (openDashboardTask
      // → openTask → ensurePanel('task-detail')).
      case 'tasks': return <TasksPanel
        scope={dashScope} setScope={(s) => { setDashScope(s); if (s === 'all') refreshDashboard(); }}
        tab={dashTab} setTab={setDashTab} boards={dashBoards} busy={dashBusy} onRefresh={refreshDashboard}
        onOpenTask={openDashboardTask}
        onStopTask={(t) => { if (!t.workspaceRoot || t.workspaceRoot === activeRoot) { window.brainrouter.send({ kind: 'interrupt' }); setToast('Interrupt sent to this workspace.'); } else { switchToWorkspace(t.workspaceRoot); setToast('Opening that workspace before stopping its tasks.'); } }}
        onKill={(id) => { q('a-killbg', 'action:kill-bgshell', { id }); setTimeout(() => q('q-fleet', 'fleet'), 150); }}
        branches={branches.branches}
        onStartSuggested={(prompt, opts) => {
          if (opts.mode === 'here') { setDraft(prompt); setToast('Suggested task added to the composer — press Enter to start.'); return; }
          if (opts.mode === 'session') { window.brainrouter.send({ kind: 'new-session' } as never); setDraft(prompt); setToast('New session ready — press Enter to start the task.'); return; }
          // worktree — run NOW on an isolated git worktree (the agent creates it,
          // like the "review PR on a worktree" flow), so the working tree is untouched.
          // The finalize step is ASK-FIRST and forbids touching the main tree — a
          // botched merge-back can wreck uncommitted work, so the agent must stop
          // and let the human choose PR / local merge / leave.
          const base = opts.branch || 'HEAD';
          const wtPrompt = [
            prompt,
            '',
            'Run this in an ISOLATED git worktree so my main working tree is never touched. Follow these rules exactly:',
            `1. Create a NEW branch + worktree for it, e.g. \`git worktree add -b task/<short-name> .worktrees/<short-name> ${base}\`. Do ALL work inside that worktree directory.`,
            '2. NEVER run `git checkout`/`switch`/`merge`/`reset` or `git worktree remove` in my MAIN working tree — my uncommitted work must stay exactly as it is.',
            '3. When done, COMMIT the work on the new branch inside the worktree so nothing can be lost.',
            `4. Then STOP: show me the branch name, a summary, and the diff, and ASK how I want to land it — (a) open a Pull Request, (b) merge locally into \`${base}\`, or (c) leave it on the branch. WAIT for my answer; do not merge, push, or delete anything on your own.`,
            '5. Only after I explicitly confirm should you merge/push or remove the worktree.',
          ].join('\n');
          submit(wtPrompt);
          setToast(opts.branch ? `Starting in an isolated worktree off ${opts.branch} — I'll ask before merging.` : "Starting in an isolated worktree — I'll ask before merging.");
        }} />;
      case 'task-detail': return <TaskDetailPanel task={taskView} renderRow={renderRow}
        onBack={() => { setTaskView(null); closeSideTab('task-detail'); }}
        onInterrupt={() => { requestStop(); setToast('Interrupt sent.'); }} />;
      case 'plan': {
        // §7 — record an approval/changes-requested decision, then re-fetch the
        // history so the new version appears in the panel.
        const refreshHistory = () => setTimeout(() => q('q-plan-history', 'plan-history'), 150);
        return <PlanPanel plan={lastPlan} history={planHistory} annotations={annotations}
          onApprove={() => { q('q-plan-decision', 'plan-record-decision', { verdict: 'approved' }); refreshHistory(); setToast('Plan approved — snapshot saved to the version history.'); }}
          onRequestChanges={(feedback) => {
            // §1 — launch a REAL background plan-revision task (the host returns
            // it; q-plan-decision surfaces success/error). Stash the feedback so
            // it can be restored to the composer if the task fails to start.
            planFeedbackRef.current = feedback;
            q('q-plan-decision', 'plan-record-decision', { verdict: 'changes-requested', feedback });
            refreshHistory();
            ensurePanel('tasks');
            setToast('Requesting changes — starting a background revision task…');
          }}
          onAnnotateStep={(item, index, body) => {
            q('q-annot-create', 'annotation-create', {
              type: 'plan',
              targetId: `plan-step:${index + 1}`,
              body,
              anchor: { block: `Step ${index + 1}`, selectedText: item.step },
            });
            setTimeout(() => q('q-annot', 'annotation-list'), 150);
            setToast('Plan step saved as an annotation.');
          }} />;
      }
      case 'search': return <SearchPanel hits={searchHits} onSearch={(query) => q('q-search', 'search-transcript', { q: query })} />;
      case 'workflows': return <WorkflowsPanel />;
      case 'memory': return <MemoryPanel />;
      case 'knowledge': return <KnowledgePanel workspaceKey={activeRoot} />;
      case 'prototype': return <PrototypePanel onSendToChat={(text) => { setDraft(text); setToast('Prototype prompt sent to the composer — press Enter to generate.'); }} />;
      case 'schedule': return <SchedulePanel schedules={schedules} now={Date.now()}
        onAdd={(kind, expr, command) => { q('q-schedule', 'schedule-add', { kind, expr, command }); setTimeout(() => q('q-schedule', 'schedule-list'), 150); }}
        onRemove={(id) => { q('q-schedule', 'schedule-remove', { id }); setTimeout(() => q('q-schedule', 'schedule-list'), 150); }}
        onToggle={(id, enabled) => { q('q-schedule', 'schedule-toggle', { id, enabled }); setTimeout(() => q('q-schedule', 'schedule-list'), 150); }} />;
      case 'worktrees': return <WorktreesPanel worktrees={worktrees} diffs={worktreeDiffs}
        onCreate={(name, ref) => { q('q-worktree-create', 'worktree-create', { name, ref }); setTimeout(() => q('q-worktrees', 'git-worktrees'), 250); }}
        onRemove={(path) => { q('q-worktree-remove', 'worktree-remove', { path }); setTimeout(() => q('q-worktrees', 'git-worktrees'), 250); }}
        onOpen={(path) => openWorktree(path)}
        onDiff={(path) => q('q-worktree-diff', 'worktree-diff', { path })} />;
      case 'review': {
        const refresh = () => setTimeout(() => q('q-review-current', 'review-current'), 120);
        const fixPrompt = (f: ReviewFindingView) => `Fix this review finding in \`${f.file}${f.line ? `:${f.line}` : ''}\` (${f.severity}): ${f.summary}`;
        return <ReviewPanel review={review} gate={reviewGate} running={reviewRunning}
          onRun={() => { setReviewRunningByWs((m) => ({ ...m, [activeRoot]: true })); setReviewByWs((m) => setEntry(m, activeRoot, null)); q('q-review-diff', 'review-diff'); }}
          onDiscuss={(f) => setDraft(`About the review finding in \`${f.file}${f.line ? `:${f.line}` : ''}\` (${f.severity}): ${f.summary}\n\nWhat's the fix?`)}
          onApply={(f) => { if (f.id) { q('q-review-apply', 'review-apply-suggestion', { id: f.id }); refresh(); setTimeout(() => { q('q-files', 'changed-files'); q('q-gitinfo', 'git-info'); }, 450); } }}
          onAskFix={(f) => {
            // T3 — launch a scoped fix agent for THIS finding (not just a draft);
            // it edits the file, then the review re-runs. Falls back to a draft if
            // the finding has no id.
            if (f.id) { setReviewRunningByWs((m) => ({ ...m, [activeRoot]: true })); setToast('Fixing this finding — the agent is editing the file…'); q('q-review-fix', 'review-fix-finding', { id: f.id }); }
            else { setDraft(fixPrompt(f)); setToast('Fix request drafted — press Enter to ask the agent.'); }
          }}
          onDismiss={(f) => { if (f.id) { q('q-review-dismiss', 'review-dismiss-finding', { id: f.id }); refresh(); } }}
          onResolve={(f) => { if (f.id) { q('q-review-resolve', 'review-resolve-finding', { id: f.id }); refresh(); } }}
          onTriage={(f, status) => { if (f.id) { q('q-review-triage', 'review-set-finding-status', { id: f.id, status }); refresh(); } }}
          onAnnotate={(f) => {
            // §9 — capture a review finding as a durable annotation: a review-finding
            // record referencing the finding by id, anchored to its file/lines, with
            // the finding's severity. Refreshes the annotation slice afterwards.
            const sev = (['info', 'low', 'medium', 'high'] as const).includes(f.severity as never) ? f.severity : undefined;
            q('q-annot-create', 'annotation-create', {
              type: 'review-finding', targetId: f.id, body: f.summary, severity: sev,
              anchor: { filePath: f.file, startLine: f.line, endLine: f.endLine },
            });
            setTimeout(() => q('q-annot', 'annotation-list'), 150);
            setToast('Finding saved as an annotation — see the Annotations view.');
          }}
          onOpenFile={(f) => openFile(f.file)}
          onOpenDiff={(f) => { setDiffTarget({ path: f.file, line: f.line }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: f.file }); }} />;
      }
      case 'atlas':
        return <AtlasPanel graph={atlasGraph} building={atlasBuilding} enriching={atlasEnriching}
          onLoad={() => q('q-atlas', 'atlas-graph')}
          onBuild={() => { setAtlasBuilding(true); q('q-atlas-build', 'atlas-build'); }}
          onEnrich={() => { setAtlasEnriching(true); q('q-atlas-enrich', 'atlas-enrich'); }}
          onOpenFile={openFile} changedFiles={changedFiles}
          assessments={atlasAssessments} assessing={atlasAssessing}
          onAssess={(path) => { setAtlasAssessing(path); q('q-atlas-explain', 'atlas-explain-change', { path }); }}
          uiMap={atlasUiMap}
          onLoadUiMap={() => q('q-browser-manifest', 'browser:manifest')}
          onExtractUi={(opts) => q('q-browser-extract', 'browser:extract', { ...(opts?.only?.length ? { only: opts.only } : {}), broad: !!opts?.broad })}
          onDriveElement={(el) => {
            ensurePanel('browser');
            try { localStorage.setItem('br-browser-focus', JSON.stringify({ ...el, at: Date.now() })); } catch { /* ignore */ }
            window.dispatchEvent(new CustomEvent('br-browser-focus'));
            setToast(`Sent "${el.testID}" to the Browser panel`);
          }}
          stories={atlasStories}
          onLoadStories={() => q('q-browser-stories', 'browser:list-stories')}
          onSuggestStories={() => q('q-browser-suggest', 'browser:suggest-stories')}
          onRunStory={(story) => runStory(story)} />;
      // UI-TEST fusion — the embedded Browser panel (propless; talks to App via
      // localStorage + br-browser-* window events). Lazy + Suspense like Editor/CI.
      case 'browser':
        return <Suspense fallback={<div className="row status"><span className="spinner" /> Loading…</div>}><BrowserPanel panelVisible={active} /></Suspense>;
      case 'requirements': {
        const refresh = () => setTimeout(() => q('q-req', 'requirement-list'), 150);
        return <RequirementsPanel requirements={requirements}
          onCreate={(title) => { q('q-req-create', 'requirement-create', { title }); refresh(); }}
          onSetStatus={(id, status) => { q('q-req-update', 'requirement-update', { id, status }); refresh(); }}
          onSetPriority={(id, priority) => { q('q-req-update', 'requirement-update', { id, priority }); refresh(); }}
          onAddCriterion={(id, text) => { q('q-req-update', 'requirement-update', { id, criterion: text }); refresh(); }}
          onDelete={(id) => { q('q-req-delete', 'requirement-delete', { id }); refresh(); setToast('Requirement deleted.'); }}
          onSeedPlan={(id) => { q('q-req-seed', 'requirement-seed-plan', { id }); refresh(); setToast('Seeded this session\'s plan from the requirement — it shows in Plan on the next turn.'); }}
          onPromote={(id) => { q('q-req-promote', 'requirement-promote', { id }); refresh(); setTimeout(() => q('q-track-items', 'track-items'), 250); setToast('Promoted to ready — planned + tracked on the board.'); }}
          onApplyFramework={(text) => { setDraft(text); setToast('Framework prompt added to the composer — edit it, then press Enter.'); }} />;
      }
      case 'annotations': {
        // ANNOTATION-RECORDS — status set re-fetches the list; export round-trips
        // the markdown back through q-annot-export, which drops it into the
        // composer draft (the "export feedback to the session" path).
        const refresh = () => setTimeout(() => q('q-annot', 'annotation-list'), 150);
        return <AnnotationsPanel annotations={annotations}
          onSetStatus={(id, status) => { q('q-annot-status', 'annotation-set-status', { id, status }); refresh(); }}
          onExport={(filter) => { q('q-annot-export', 'annotation-export', filter); }}
          onAddComment={(id, body) => { q('q-annot-comment', 'annotation-add-comment', { id, body }); refresh(); }}
          onSelectTarget={(a) => { if (a.anchor?.filePath) { setDiffTarget({ path: a.anchor.filePath, line: a.anchor.startLine }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: a.anchor.filePath }); } }} />;
      }
      case 'artifacts': {
        // ARTIFACT-RECORDS — create/status-set re-fetch the list; Preview resolves
        // the artifact's content via q-art-read (file via the safe workspace read,
        // or inline), which merges the content back onto the matching record.
        const refresh = () => setTimeout(() => q('q-art', 'artifact-list'), 150);
        // §8 — annotations targeting an artifact use the artifact's format as the
        // annotation kind (markdown/html), else the generic 'artifact' target.
        const annTypeFor = (fmt: string): 'markdown' | 'html' | 'artifact' => fmt === 'markdown' ? 'markdown' : fmt === 'html' ? 'html' : 'artifact';
        return <ArtifactsPanel artifacts={artifacts} annotations={annotations}
          onCreate={(title) => { q('q-art-create', 'artifact-create', { kind: 'markdown-report', title }); refresh(); }}
          onSetStatus={(id, status) => { q('q-art-update', 'artifact-update', { id, status }); refresh(); }}
          onPreview={(a) => { q('q-art-read', 'artifact-read', { id: a.id }); }}
          onSave={(id, content) => { q('q-art-save', 'artifact-save', { id, content }); refresh(); setTimeout(() => q('q-art-read', 'artifact-read', { id }), 250); setToast('Artifact saved.'); }}
          onRevert={(id, version) => { q('q-art-revert', 'artifact-revert', { id, version }); refresh(); setTimeout(() => q('q-art-read', 'artifact-read', { id }), 250); setToast(`Reverted to v${version}.`); }}
          onSendToChat={(text) => { setDraft(text); setToast('Artifact sent to the composer — press Enter to continue.'); }}
          onAnnotate={(a, body) => { q('q-annot-create', 'annotation-create', { type: annTypeFor(a.format), targetId: a.id, artifactId: a.id, body }); setTimeout(() => q('q-annot', 'annotation-list'), 150); setToast('Annotation saved to this artifact.'); }} />;
      }
      case 'attachments':
        // Session Attachments — self-fetching viewer over the host's
        // attachment-list / attachment-read endpoints. "Reference in chat" drops
        // a prompt stub into the composer.
        return <AttachmentsPanel scope="session" onSendToChat={(text) => { setDraft(text); setToast('Attachment referenced in the composer — add your question and press Enter.'); }} />;
      default: return null;
    }
  };

  return renderPanelBody;
}
