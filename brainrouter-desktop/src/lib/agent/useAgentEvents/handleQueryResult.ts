/**
 * handleQueryResult — the giant `q-*`/`a-*` query-result router extracted from
 * useAgentEvents.ts byte-identically. Built as a factory that closes over the
 * hook's `AgentEventsCtx` exactly as the original nested function did, so the
 * switch body (and its behavior) is unchanged. The hook calls
 * `createHandleQueryResult(ctx)` once and hands the result to the event handler.
 */
import type { PlanView, ChatRow, ChangesetFile, SessionRow, FleetRow, WorkflowDetail } from '../../../types.js';
import type { TrackProject, WorkItem, Sprint, Module, SavedView, AutomationRule, ProjectMember } from '@kinqs/brainrouter-types';
import type { GitTrackContext, SyncConfig, SyncResult, TrackPrStatus } from '../../../track/TrackView.js';
import type { SearchHit, ReviewFindingView } from '../../../panels/index.js';
import type { ScheduleRecordView } from '../../schedule/scheduleView.js';
import type { PlanDecisionView } from '../../plan/planReviewView.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord, AtlasGraph } from '@kinqs/brainrouter-types';
import type { CommandsCatalog } from '../../commands/commands.js';
import type { ConfigSnapshot, UsageHistory } from '../../../settings.js';
import type { InstalledPluginView, RegistrySearchHit, ConsentSummaryView } from '../../../settings/marketplace/index.js';
import { parseWorktreeList } from '../../worktree/worktreeParser.js';
import { mergeOptimistic, dropPending } from '../../session/list/sessionOrder.js';
import { normalizeProjectSessionsResult, withCachedProjectSessions } from '../../session/workspaces/projectSessionsView.js';
import { shouldApplyTaskTranscript, shouldApplyWorkflowDetail } from '../../session/routing/taskTranscriptRouting.js';
import { setEntry, shouldProceedGate } from '../../review/reviewWorkspace.js';
import { parseQueryId, isStaleQueryResult } from '../../workspace/workspaceEvents.js';
import { fmt, download } from '../../format.js';
import { rid } from '../../rid.js';
import { type AgentEventsCtx, type ToolCatalog, getStableRowId, isWorkspaceScopedReviewQuery } from './types.js';
// BROWSER — the screen map + story journeys the browser:* results carry.
import type { UiMap, Story } from '@kinqs/brainrouter-core/browser';

export function createHandleQueryResult(ctx: AgentEventsCtx): (rawId: string, result: unknown, error?: string, resultWorkspaceRoot?: string) => void {
  const {
    setRows, setRunning, setStopping, setTurnStart, setStatusLine, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setGoalState, setPlanHistory, setTokens, setLiveTurn, setEfficiency, setTrack, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, planFeedbackRef, goalContPendingRef, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setRecentTasks, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setToolCatalog, setProviderModels, setProbedModels, setProbeLoading, setProbeError, setCatalog, setSnapshot, setUsageLines, setUsageHistory,
    setMarket,
    setSearchHits, setSchedules, setRequirements, setAnnotations, setArtifacts, setAtlasGraph, setAtlasBuilding, setAtlasEnriching, setAtlasAssessing, setAtlasAssessments, setAtlasUiMap, setAtlasStories, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setFilesLoading, setFilesTruncated, setFilesError, setAttachmentUploads,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingWorkspaceRef, pendingResumeRef, errorsBySession, lastPromptRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef, cachedSessionRowsRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  } = ctx;
  // The variables above intentionally mirror the hook's destructuring so the
  // moved switch body below stays byte-identical; ones the router doesn't touch
  // are harmless no-ops (noUnusedLocals is off for this package). Reference the
  // unused ones once so linters/bundlers don't prune the shape.
  void setRunning; void setStopping; void setTurnStart; void setStatusLine; void setReasoningTail;
  void setLiveText; void setToolLog; void setLiveChildren; void setFinishedTasks; void setGoalState;
  void setLiveTurn; void setInteraction; void setPicked; void setViewKey; void setWorkflowView;
  void setWorkspaces; void setRunningWs; void setHostUp; void setLastTurnFails;
  void liveBuf; void liveFlushPending; void turnFailsRef; void pendingResumeRef; void lastPromptRef;
  void cardOpenRef; void chatRef; void refreshSidebar; void cachedSessionRowsRef;

  // The account catalog query is intentionally independent of the much larger
  // config snapshot. It can therefore finish first during launch. Remember the
  // newest catalog in this event-router closure so a later snapshot cannot drop
  // it and leave managed models invisible until the next 30-second poll.
  let latestAccountModels: ConfigSnapshot['accountModels'] | undefined;
  // Connector counts/previews are loaded independently and only while their
  // Settings page is open. Preserve the newest lazy payload when a later,
  // lightweight config snapshot arrives.
  let latestConnectors: ConfigSnapshot['connectors'] | undefined;

  return function handleQueryResult(rawId: string, result: unknown, error?: string, resultWorkspaceRoot?: string): void {
    // Stability fix — drop results from an older workspace generation (they were
    // in flight when the user switched projects); then route by the base id.
    const id = parseQueryId(rawId).base;
    const workspaceScopedLateResult = !!resultWorkspaceRoot && isWorkspaceScopedReviewQuery(id);
    if (!workspaceScopedLateResult && isStaleQueryResult(rawId, workspaceGenRef.current)) return;
    // DESK-5d — per-project chat lists route by the root encoded in the id.
    if (id.startsWith('q-wsess:')) {
      const root = id.slice('q-wsess:'.length);
      if (error) {
        setProjSessions((p) => ({
          ...p,
          [root]: { rows: p[root]?.rows ?? [], loading: false, error, loadedAt: Date.now() },
        }));
        return;
      }
      setProjSessions((p) => ({ ...p, [root]: normalizeProjectSessionsResult(result) }));
      return;
    }
    if (error) {
      if (id === 'a-learning-correct') q('q-snapshot', 'config-snapshot');
      if (id === 'q-list') {
        setFilesLoading(false);
        setFilesTruncated(false);
        setFilesError(error);
      }
      if (id.startsWith('q-attach:')) {
        const uploadId = id.slice('q-attach:'.length);
        setAttachmentUploads((prev) => prev.map((u) => u.id === uploadId ? { ...u, status: 'failed', detail: error } : u));
      }
      setToast(`✗ ${error}`);
      return;
    }
    // WS8 — rewind result: an in-app warning (top-right toast) when blocked
    // because code was generated after the point, or a confirmation when it
    // truncated. The agent's history is rewound host-side for the next turn.
    if (id === 'a-rewind') {
      const r = result as { ok?: boolean; reason?: string } | undefined;
      if (r && r.ok === false) setToast(`⚠ ${r.reason ?? 'Rewind blocked.'}`);
      else if (r && r.ok) setToast('Rewound to here — your next message continues from this point.');
      return;
    }
    if (id === 'q-attach' || id.startsWith('q-attach:')) {
      const uploadId = id.startsWith('q-attach:') ? id.slice('q-attach:'.length) : '';
      const r = result as { ok?: boolean; attachment?: { name: string; id: string; kind: string }; contextMarkdown?: string; error?: string } | null;
      if (r?.ok && r.attachment) {
        if (uploadId) {
          setAttachmentUploads((prev) => prev.map((u) => u.id === uploadId ? {
            ...u,
            status: 'attached',
            attachmentId: r.attachment!.id,
            kind: r.attachment!.kind,
            detail: r.attachment!.kind,
            contextMarkdown: r.contextMarkdown,
          } : u));
        }
        setToast(`✓ Attached ${r.attachment.name}`);
        q('q-fleet', 'fleet');
      } else {
        const detail = r?.error ?? 'Attachment failed.';
        if (uploadId) setAttachmentUploads((prev) => prev.map((u) => u.id === uploadId ? { ...u, status: 'failed', detail } : u));
        setToast(`✗ Attach failed: ${detail}`);
      }
      return;
    }
    switch (id) {
      case 'q-sessions': if (Array.isArray(result)) {
        const hostRows = result as SessionRow[];
        // Wave 2 — drop optimistic rows the host now confirms, then merge the
        // still-pending ones so a brand-new chat never vanishes on a refresh.
        pendingSessionsRef.current = dropPending(pendingSessionsRef.current, hostRows.map((r) => r.sessionKey));
        const merged = mergeOptimistic(hostRows, pendingSessionsRef.current);
        setSessions(merged); sessionsRef.current = merged;
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot;
        setProjSessions((prev) => withCachedProjectSessions(prev, root, merged));
      } return;
      case 'q-pr': setPrInfo(((result as { pr?: { number: number; state: string; title?: string } | null })?.pr) ?? null); return;
      case 'q-ctx': if (result && typeof result === 'object') {
        const u = result as { used: number; window: number; compactAt: number; limit: number; pct: number };
        // Auto-compaction must trigger WITHIN the model window — clamp the
        // threshold to the window so its bar never shows a max larger than the
        // model window (a knob bigger than the window can never fire: the
        // provider rejects the request before that many tokens accrue).
        const compactAt = u.window > 0 ? Math.min(u.compactAt, u.window) : u.compactAt;
        const limit = compactAt > 0 ? compactAt : u.window;
        setContextUsage({ ...u, compactAt, limit, pct: limit > 0 ? Math.min(1, u.used / limit) : 0 });
      } return;
      // TRACK mode — project + work items. Create/transition return the updated list.
      case 'q-track-project': setTrack((t) => ({ ...t, project: (result as TrackProject | null) ?? null })); return;
      case 'q-track-items': case 'q-track-create': case 'q-track-transition':
      case 'q-track-update-item': case 'q-track-comment': case 'q-track-link': case 'q-track-assign-sprint': case 'q-track-assign-module':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, items: result as WorkItem[] }));
        return;
      case 'q-track-sprints': case 'q-track-create-sprint': case 'q-track-sprint-state':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, sprints: result as Sprint[] }));
        return;
      case 'q-track-modules': case 'q-track-create-module': case 'q-track-module-update': case 'q-track-module-delete':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, modules: result as Module[] }));
        return;
      case 'q-track-views': case 'q-track-save-view': case 'q-track-delete-view':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, views: result as SavedView[] }));
        return;
      case 'q-track-automations': case 'q-track-create-automation':
      case 'q-track-update-automation': case 'q-track-delete-automation':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, automations: result as AutomationRule[] }));
        return;
      case 'q-track-members': case 'q-track-add-member':
      case 'q-track-update-member-role': case 'q-track-remove-member':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, members: result as ProjectMember[] }));
        return;
      case 'q-track-sync-members': {
        const r = result as { members?: ProjectMember[]; added?: string[]; errors?: string[] } | null;
        if (Array.isArray(r?.members)) setTrack((t) => ({ ...t, members: r!.members! }));
        if (r) setToast(`Pulled ${r.added?.length ?? 0} member(s) from GitHub${r.errors?.length ? ` · ${r.errors.length} error(s)` : ''}.`);
        return;
      }
      case 'q-track-sync-config':
        if (result && typeof result === 'object') setTrack((t) => ({ ...t, sync: { ...t.sync, config: result as SyncConfig } }));
        return;
      case 'q-track-git-context':
        if (result && typeof result === 'object') setTrack((t) => ({ ...t, git: result as GitTrackContext }));
        return;
      case 'q-track-start-work': {
        const r = result as { ok?: boolean; error?: string; branch?: string; items?: WorkItem[]; context?: GitTrackContext } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({ ...t, items: r!.items!, git: r!.context ?? t.git }));
        if (r?.error) setToast(`Git start failed: ${r.error}`);
        else if (r?.branch) setToast(`Started ${r.branch}.`);
        return;
      }
      case 'q-track-pr-status':
        if (result && typeof result === 'object') setTrack((t) => ({ ...t, pr: result as TrackPrStatus }));
        return;
      case 'q-track-create-pr': {
        const r = result as { ok?: boolean; error?: string; url?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string; items?: WorkItem[] } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({
          ...t,
          items: r!.items!,
          pr: { pr: r!.pr ?? null, branch: r!.branch ?? null, itemKey: r!.itemKey },
        }));
        if (r?.error) setToast(`Draft PR failed: ${r.error}`);
        else if (r?.url) setToast(`Created draft PR: ${r.url}`);
        return;
      }
      case 'q-track-gh-issues': {
        const r = result as (SyncResult & { items?: WorkItem[] }) | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({ ...t, items: r!.items!, sync: { ...t.sync, result: r as SyncResult } }));
        if (r) setToast(`Imported ${r.imported?.length ?? 0} issue(s) via gh${r.errors?.length ? ` · ${r.errors.length} error(s)` : ''}.`);
        return;
      }
      case 'q-track-merge-pr': {
        const r = result as { ok?: boolean; error?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string; items?: WorkItem[] } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({
          ...t,
          items: r!.items!,
          pr: { pr: r!.ok ? null : (r!.pr ?? null), branch: r!.branch ?? null, itemKey: r!.itemKey },
        }));
        if (r?.error) setToast(`Merge failed: ${r.error}`);
        else if (r?.ok) setToast('Pull request merged.');
        return;
      }
      case 'q-track-submit-pr-review': {
        const r = result as { ok?: boolean; error?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string } | null;
        if (r) setTrack((t) => ({ ...t, pr: { pr: r.pr ?? t.pr?.pr ?? null, branch: r.branch ?? t.pr?.branch ?? null, itemKey: r.itemKey ?? t.pr?.itemKey } }));
        if (r?.error) setToast(`Review failed: ${r.error}`);
        else if (r?.ok) setToast('Pull request review submitted.');
        return;
      }
      case 'q-track-fix-checks': {
        const r = result as { ok?: boolean; error?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string; task?: { id?: string } } | null;
        if (r) setTrack((t) => ({ ...t, pr: { pr: r.pr ?? t.pr?.pr ?? null, branch: r.branch ?? t.pr?.branch ?? null, itemKey: r.itemKey ?? t.pr?.itemKey } }));
        if (r?.error) setToast(`Fix checks failed: ${r.error}`);
        else if (r?.ok) {
          setToast('Fix checks task started — see Background tasks.');
          q('q-fleet', 'fleet');
        }
        return;
      }
      case 'q-track-sync': {
        const r = result as SyncResult | null;
        if (!r || typeof r !== 'object') return;
        setTrack((t) => ({
          ...t,
          ...(Array.isArray(r.items) ? { items: r.items } : {}),
          sync: { ...t.sync, result: r },
        }));
        const errors = Array.isArray(r.errors) ? r.errors.length : 0;
        const changed = r.direction === 'sync'
          ? (r.pushed ?? 0) + (r.pulled ?? 0) + (r.created?.local ?? 0) + (r.created?.remote ?? 0)
          : (r.exported ?? r.imported ?? []).length;
        const conflicts = r.conflicts?.length ?? 0;
        setToast(errors
          ? `GitHub sync finished with ${errors} error${errors === 1 ? '' : 's'} — review the sync result.`
          : conflicts
            ? `GitHub sync found ${conflicts} conflict${conflicts === 1 ? '' : 's'} — both versions were preserved for review.`
          : r.dryRun
            ? `GitHub sync preview ready — ${changed} change${changed === 1 ? '' : 's'} found.`
            : changed
              ? `GitHub sync applied ${changed} change${changed === 1 ? '' : 's'} and refreshed Track.`
              : 'GitHub and Track are already in sync — no changes were needed.');
        return;
      }
      case 'q-track-scan': {
        const r = result as { scanned?: number; linked?: unknown[]; transitioned?: unknown[]; items?: WorkItem[] } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({ ...t, items: r!.items! }));
        if (r) setToast(`Scanned ${r.scanned ?? 0} commit(s) — ${r.linked?.length ?? 0} linked, ${r.transitioned?.length ?? 0} advanced.`);
        return;
      }
      case 'q-turn-changeset': {
        // End-of-turn changeset → append a card right after the final answer.
        const r = result as { files?: ChangesetFile[]; insertions?: number; deletions?: number } | null;
        if (r && Array.isArray(r.files) && r.files.length) {
          setRows((rows) => [...rows, { id: rid(), kind: 'changeset', files: r.files!, insertions: r.insertions ?? 0, deletions: r.deletions ?? 0, ts: Date.now() }]);
        }
        return;
      }
      case 'q-plan': {
        // This session's durable plan (empty for a new chat). Null/empty → clear
        // the panel rather than leave the previous session's plan showing.
        const p = result as PlanView | null;
        setLastPlan(p && Array.isArray(p.items) && p.items.length ? p : null);
        return;
      }
      // §7 PLAN REVIEW — this session's plan decision history (the version log).
      case 'q-plan-history': if (Array.isArray(result)) setPlanHistory(result as PlanDecisionView[]); return;
      // Approve / request-changes round-trips: surface an error, else refresh the
      // history so the new decision appears (the App layer re-fetches q-plan-history).
      case 'q-plan-decision': {
        const r = result as { error?: string; taskError?: string; task?: { id: string; title?: string } } | null;
        if (r && typeof r === 'object') {
          if (typeof r.error === 'string') setToast(`✗ ${r.error}`);
          else if (typeof r.taskError === 'string') {
            // §1 — the revision task couldn't start: surface the error and
            // restore the feedback draft so the user doesn't lose it.
            setToast(`✗ Could not start the revision task: ${r.taskError}`);
            if (planFeedbackRef.current) setDraft(planFeedbackRef.current);
          } else if (r.task) {
            setToast('Revision task started — see Background tasks.');
            q('q-fleet', 'fleet');
            planFeedbackRef.current = '';
          }
        }
        return;
      }
      case 'q-fleet': if (Array.isArray(result)) setFleet(result as FleetRow[]); return;
      case 'q-tasks-recent': {
        // §3 — durable tasks (all statuses). Keep the TERMINAL ones (completed/
        // failed/canceled) as a FleetRow-shaped "recently finished" list; the
        // running ones already arrive via q-fleet. Clicking reopens the result.
        if (!Array.isArray(result)) return;
        const rows = (result as Array<Record<string, unknown>>)
          .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'canceled')
          .slice(0, 25)
          .map((t) => ({
            kind: String(t.kind ?? 'agent'), id: String(t.id ?? ''), label: String(t.title ?? t.id ?? ''),
            startedAt: typeof t.startedAt === 'string' ? t.startedAt : (typeof t.createdAt === 'string' ? t.createdAt : undefined),
            status: String(t.status ?? ''), durable: true,
            parentSessionKey: typeof t.sessionKey === 'string' ? t.sessionKey : null,
            transcript: t.transcript as FleetRow['transcript'],
          })) as FleetRow[];
        setRecentTasks(rows);
        return;
      }
      case 'q-info': if (result && typeof result === 'object') setInfo(result as typeof info); return;
      case 'q-files': if (Array.isArray(result)) setChangedFiles(result as Array<{ status: string; path: string }>); return;
      case 'q-diff': if (result && typeof result === 'object') setDiffView(result as { path: string; diff: string }); return;
      case 'q-inline-diff': {
        const r = result as { path?: string; diff?: string };
        if (r?.path) setInlineDiffs((d) => ({ ...d, [r.path!]: r.diff ?? '' }));
        return;
      }
      case 'q-list': {
        setFilesLoading(false);
        if (result && typeof result === 'object') {
          const r = result as { files?: string[]; truncated?: boolean };
          if (typeof (r as { error?: unknown }).error === 'string') {
            setAllFiles([]);
            setFilesTruncated(false);
            setFilesError((r as { error: string }).error);
            setToast(`✗ ${(r as { error: string }).error}`);
            return;
          }
          setAllFiles(Array.isArray(r.files) ? r.files : []);
          setFilesTruncated(!!r.truncated);
          setFilesError('');
        } else {
          setAllFiles([]);
          setFilesTruncated(false);
          setFilesError('');
        }
        return;
      }
      case 'q-read': if (result && typeof result === 'object') setFileView(result as { path: string; content: string }); return;
      case 'q-git': if (result && typeof result === 'object') setGitInfo(result as typeof gitInfo); return;
      case 'q-gitlog': if (result && typeof result === 'object') setCommitSubjects(((result as { subjects?: string[] }).subjects ?? [])); return;
      case 'q-home': if (result && typeof result === 'object') setHomeStats(result as typeof homeStats); return;
      case 'q-branches': if (result && typeof result === 'object') setBranches(result as typeof branches); return;
      case 'q-models': {
        setModelsLoading(false);
        if (result && typeof result === 'object') {
          const r = result as { models?: string[]; provider?: string };
          // A named-provider result feeds the per-provider map (sub-agent model
          // pickers); the active endpoint feeds the main list. Both come from the
          // endpoint's /models — never a hand-written list.
          if (r.provider) setProviderModels((prev) => ({ ...prev, [r.provider!]: r.models ?? [] }));
          else setEndpointModels(r.models ?? []);
        }
        return;
      }
      case 'q-toolcat': {
        if (result && typeof result === 'object') {
          const r = result as Partial<ToolCatalog>;
          setToolCatalog({ builtin: r.builtin ?? [], mcp: r.mcp ?? [] });
        }
        return;
      }
      // §multi-select-models — a draft-key probe from the Models setup dialog.
      // Feeds its OWN state (never endpointModels), so it can't race the on-open
      // model load. An empty list means the key/endpoint unlocked nothing.
      case 'q-probe': {
        setProbeLoading(false);
        const r = (result && typeof result === 'object') ? result as { models?: string[]; error?: string } : { models: [] };
        const models = r.models ?? [];
        setProbedModels(models);
        // error reason (http-401 = bad key, unreachable = CORS/network) takes
        // precedence so the dialog can validate the key; else generic no-models.
        setProbeError(models.length ? '' : ((r as { error?: string }).error || 'no-models'));
        return;
      }
      // §multi-provider — visible feedback (banner) for the Models-panel actions,
      // so creating/removing/defaulting a provider never silently does nothing.
      case 'a-setprov': {
        const r = result as { ok?: boolean; name?: string; error?: string } | null;
        setToast(r && r.ok ? `✓ Connected ${r.name ?? 'provider'}` : `✗ Couldn't save provider${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'a-rmprov': {
        const r = result as { ok?: boolean; name?: string; error?: string } | null;
        setToast(r && r.ok ? `✓ Removed ${r.name ?? 'provider'}` : `✗ Couldn't remove provider${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'a-setdefault': {
        const r = result as { ok?: boolean; error?: string } | null;
        setToast(r && r.ok ? '✓ Primary provider updated' : `✗ Couldn't set primary${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'q-catalog': if (result && typeof result === 'object') setCatalog(result as CommandsCatalog); return;
      case 'q-snapshot': if (result && typeof result === 'object') {
        const next = result as ConfigSnapshot;
        setSnapshot({
          ...next,
          ...(latestAccountModels ? { accountModels: latestAccountModels } : {}),
          ...(latestConnectors ? { connectors: latestConnectors } : {}),
        });
        return;
      }
      case 'q-account-models': if (result && typeof result === 'object') {
        latestAccountModels = result as ConfigSnapshot['accountModels'];
        setSnapshot((current) => current ? { ...current, accountModels: latestAccountModels } : current);
        return;
      }
      case 'q-connectors': if (result && typeof result === 'object') {
        latestConnectors = result as ConfigSnapshot['connectors'];
        setSnapshot((current) => current ? { ...current, connectors: latestConnectors } : current);
        return;
      }
      case 'q-usage': if (Array.isArray(result)) setUsageLines(result as string[]); return;
      case 'q-usage-hist': if (result && typeof result === 'object') setUsageHistory(result as UsageHistory); return;
      // PLUGIN-MARKETPLACE P4-desktop — Marketplace panel results. The host does
      // all fs/git work; these just fold the returned data into the market slice.
      case 'q-plugin-list': {
        const r = result as { plugins?: InstalledPluginView[]; errors?: string[] } | null;
        setMarket((m) => ({ ...m, installed: Array.isArray(r?.plugins) ? r!.plugins! : [] }));
        return;
      }
      case 'q-plugin-search': {
        const r = result as { ok?: boolean; hits?: RegistrySearchHit[]; error?: string } | null;
        setMarket((m) => ({ ...m, searching: false, hits: Array.isArray(r?.hits) ? r!.hits! : [], error: r?.ok === false ? (r.error ?? 'registry unavailable') : '' }));
        return;
      }
      case 'q-plugin-consent': {
        // The host echoes the pending action/scope alongside the disclosure so we
        // can pair the summary with the button the user clicked (install/enable).
        const r = result as { ok?: boolean; summary?: ConsentSummaryView; action?: 'install' | 'enable'; scope?: 'user' | 'workspace'; error?: string } | null;
        if (r?.ok && r.summary) {
          setMarket((m) => ({ ...m, consent: { plugin: r.summary!.name, scope: r.scope ?? 'user', action: r.action ?? 'install', summary: r.summary! } }));
        } else if (r?.error) {
          setToast(`✗ ${r.error}`);
        }
        return;
      }
      case 'plugin-consent-close': setMarket((m) => ({ ...m, consent: null, consentRequest: null })); return;
      case 'a-plugin-install': {
        const r = result as { ok?: boolean; name?: string; error?: string } | null;
        setMarket((m) => ({ ...m, consent: null }));
        setToast(r?.ok ? `✓ Installed ${r.name ?? 'plugin'}` : `✗ Install failed${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'a-plugin-enable': {
        const r = result as { ok?: boolean; error?: string } | null;
        setMarket((m) => ({ ...m, consent: null }));
        if (r && r.ok === false) setToast(`✗ ${r.error ?? 'Could not update the plugin.'}`);
        return;
      }
      case 'a-plugin-remove': {
        const r = result as { ok?: boolean; error?: string } | null;
        setToast(r?.ok ? '✓ Plugin removed.' : `✗ Remove failed${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'a-plugin-consent-set': return; // silent — the panel refreshes the installed list
      case 'a-plugin-consent-close': setMarket((m) => ({ ...m, consent: null })); return;
      case 'q-search': if (Array.isArray(result)) setSearchHits(result as SearchHit[]); return;
      case 'q-schedule': if (Array.isArray(result)) setSchedules(result as ScheduleRecordView[]); return;
      // REQUIREMENT-RECORDS — the list populates the slice; create/update/seed use
      // their own ids (q-req-create/q-req-update/q-req-seed) and just trigger a
      // refresh via q-req, except seed/error which surfaces a toast.
      case 'q-req': if (Array.isArray(result)) setRequirements(result as RequirementRecord[]); return;
      case 'q-atlas': setAtlasGraph(result && typeof result === 'object' && Array.isArray((result as { nodes?: unknown }).nodes) ? (result as AtlasGraph) : null); return;
      case 'q-atlas-build': { const g = (result as { graph?: AtlasGraph } | null)?.graph ?? null; if (g) setAtlasGraph(g); setAtlasBuilding(false); return; }
      case 'q-atlas-enrich': {
        const r = result as { graph?: AtlasGraph; error?: string; enrichResult?: { summarized: number; layers: number; tourSteps: number; batchesFailed: number } } | null;
        setAtlasEnriching(false);
        if (r?.error) { setToast(`⚠ ${r.error}`); return; }
        if (r?.graph) setAtlasGraph(r.graph);
        const er = r?.enrichResult;
        if (er) setToast(`✓ Atlas enriched — ${er.summarized} summaries · ${er.layers} layers · ${er.tourSteps} tour`);
        return;
      }
      case 'q-atlas-explain': {
        const r = result as { path?: string; error?: string; assessment?: import('../../atlas/atlasView.js').AtlasChangeAssessment } | null;
        setAtlasAssessing(null);
        if (r?.error) { setToast(`⚠ ${r.error}`); return; }
        if (r?.path && r.assessment) setAtlasAssessments((prev) => ({ ...prev, [r.path as string]: r.assessment! }));
        return;
      }
      // UI-TEST fusion — the Atlas "Screens" map + user-journey stories, and the
      // Browser panel's run/extract/suggest/report round-trips.
      case 'q-browser-manifest': { const m = (result as { manifest?: UiMap } | null)?.manifest ?? null; setAtlasUiMap(m); return; }
      case 'q-browser-extract': {
        const r = result as { manifest?: UiMap; error?: string; degraded?: boolean } | null;
        if (r?.error) { setToast(`⚠ UI extract: ${r.error}`); return; }
        if (r?.manifest) setAtlasUiMap(r.manifest);
        return;
      }
      case 'q-browser-stories': { const st = (result as { stories?: Story[] } | null)?.stories; setAtlasStories(Array.isArray(st) ? st : []); return; }
      case 'q-browser-suggest': {
        const r = result as { stories?: Story[]; count?: number; error?: string } | null;
        if (r?.error) { setToast(`⚠ Suggest stories: ${r.error}`); return; }
        const n = r?.count ?? r?.stories?.length ?? 0;
        setToast(n ? `✓ ${n} stor${n === 1 ? 'y' : 'ies'} suggested` : 'No stories suggested — try extracting first.');
        q('q-browser-stories', 'browser:list-stories');
        return;
      }
      case 'q-browser-ensure': {
        const r = result as { url?: string; started?: boolean; error?: string; note?: string } | null;
        const log = (message: string): void => { window.dispatchEvent(new CustomEvent('br-browser-log', { detail: { message } })); };
        if (r?.error) { setToast(`⚠ ${r.error}`); log(`⚠ App not ready: ${r.error}`); return; }
        if (r?.url) {
          if (r.note) { setToast(r.note); log(r.note); }
          log(`App ready on ${r.url}${r.started ? ' (started dev server)' : ''} — running the story…`);
          window.dispatchEvent(new CustomEvent('br-browser-runstory', { detail: { url: r.url, started: !!r.started } }));
        }
        return;
      }
      case 'q-browser-shot': {
        const r = result as { path?: string; error?: string } | null;
        setToast(r?.error ? `⚠ Screenshot: ${r.error}` : r?.path ? `✓ Screenshot saved → ${r.path}` : 'Screenshot saved');
        return;
      }
      case 'q-browser-report': {
        const r = result as { reportPath?: string; error?: string } | null;
        const msg = r?.error ? `⚠ Report: ${r.error}` : r?.reportPath ? `✓ Run report saved → Artifacts (${r.reportPath})` : 'Run report saved';
        setToast(msg);
        window.dispatchEvent(new CustomEvent('br-browser-log', { detail: { message: msg } }));
        return;
      }
      case 'q-req-create': case 'q-req-update': case 'q-req-seed': {
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      // ANNOTATION-RECORDS — the list populates the slice; status/create use their
      // own ids and just refresh via q-annot (surfacing any error toast). Export
      // round-trips the markdown into the composer draft (export-to-session path).
      case 'q-annot': if (Array.isArray(result)) setAnnotations(result as AnnotationRecord[]); return;
      case 'q-annot-status': case 'q-annot-create': case 'q-annot-comment': {
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      case 'q-annot-export': {
        const r = result as { markdown?: string } | null;
        if (r && typeof r.markdown === 'string') { setDraft(r.markdown); setToast('Annotations exported to the chat — press Enter to send the feedback to the agent.'); }
        return;
      }
      // ARTIFACT-RECORDS — the list populates the slice; create/status use their
      // own ids and just refresh via q-art (surfacing any error toast). The
      // Preview fetch (q-art-read) merges the resolved content onto the matching
      // record so the detail view's preview renders without a parallel state slice.
      case 'q-art': if (Array.isArray(result)) setArtifacts(result as ArtifactRecord[]); return;
      case 'q-art-create': case 'q-art-update': case 'q-art-save': {
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      case 'q-art-read': {
        const r = result as { id?: string; content?: string; error?: string } | null;
        if (!r || typeof r.id !== 'string') return;
        if (typeof r.error === 'string') { setToast(`✗ ${r.error}`); return; }
        if (typeof r.content === 'string') setArtifacts((list) => list.map((a) => (a.id === r.id ? { ...a, content: r.content } : a)));
        return;
      }
      case 'q-worktrees': {
        const r = result as { raw?: string; current?: string } | null;
        if (r && typeof r.raw === 'string') setWorktrees(parseWorktreeList(r.raw, r.current));
        return;
      }
      case 'q-worktree-diff': {
        const r = result as { path?: string; diff?: string } | null;
        if (r && typeof r.path === 'string') setWorktreeDiffs((d) => ({ ...d, [r.path!]: r.diff ?? '' }));
        return;
      }
      case 'q-review-diff': {
        // T2 — write under the workspace that's active at result time (stale-gen
        // results are already dropped upstream), so reviews never cross workspaces.
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewRunningByWs((m) => ({ ...m, [root]: false }));
        const r = result as { findings?: ReviewFindingView[]; summary?: string; files?: number } | null;
        setReviewByWs((m) => setEntry(m, root, r ? { findings: r.findings ?? [], summary: r.summary ?? '', files: r.files ?? 0 } : { findings: [], summary: 'Review failed.', files: 0 }));
        const activeRootNow = activeWsRef.current ?? info.workspaceRoot ?? '';
        if (root === activeRootNow && !pendingWorkspaceRef.current) {
          q('q-review-current', 'review-current'); // refresh the gate + finding statuses
          // If a commit/push was waiting on a freshly-run review, re-check the gate.
          if (pendingGitRef.current) q('q-review-gate', 'review-gate');
        }
        return;
      }
      case 'q-review-current': {
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        const r = result as { run?: { findings?: ReviewFindingView[]; summary?: string } | null; gate?: { status: string; blocked: boolean; reason: string }; files?: number } | null;
        setReviewGateByWs((m) => setEntry(m, root, r?.gate ?? null));
        if (r?.run) setReviewByWs((m) => setEntry(m, root, { findings: r.run!.findings ?? [], summary: r.run!.summary ?? '', files: r.files ?? 0 }));
        return;
      }
      case 'q-review-gate': {
        const r = result as { gate?: { blocked?: boolean; reason?: string; status?: string } } | null;
        const gate = r?.gate ?? { blocked: true, reason: 'Review status unavailable.', status: 'needs-review' };
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewGateByWs((m) => setEntry(m, root, { status: gate.status ?? 'needs-review', blocked: !!gate.blocked, reason: gate.reason ?? '' }));
        const pending = pendingGitRef.current;
        if (!pending) return;
        if (gate.blocked) {
          setGateBlock({ kind: pending.kind, msg: pending.msg, reason: gate.reason ?? 'Review required.', status: gate.status ?? 'needs-review' });
        } else {
          pendingGitRef.current = null;
          // §7 + T2 stale-guard: a CLEAN gate from workspace A must NOT clear a
          // commit/push the user started in workspace B (after switching mid-flight).
          const activeRootNow = activeWsRef.current ?? info.workspaceRoot ?? '';
          if (shouldProceedGate(pending.root, root) && root === activeRootNow && !pendingWorkspaceRef.current) runGit(pending.kind, pending.msg, { reviewed: true });
          else setToast('Workspace changed before the review cleared — commit cancelled, run it again.');
        }
        return;
      }
      case 'q-review-fix': {
        // T3 — the scoped fix agent finished; it returns the re-run review.
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewRunningByWs((m) => ({ ...m, [root]: false }));
        const r = result as { ok?: boolean; error?: string; run?: { findings?: ReviewFindingView[]; summary?: string }; files?: number } | null;
        if (r?.ok && r.run) {
          setReviewByWs((m) => setEntry(m, root, { findings: r.run!.findings ?? [], summary: r.run!.summary ?? '', files: r.files ?? 0 }));
          const activeRootNow = activeWsRef.current ?? info.workspaceRoot ?? '';
          if (root === activeRootNow && !pendingWorkspaceRef.current) {
            setToast('Finding fixed — review re-run over the new changes.');
            q('q-review-current', 'review-current'); q('q-files', 'changed-files'); q('q-git', 'git-info');
          }
        } else {
          setToast(`Fix failed: ${r?.error ?? 'unknown error'}`);
        }
        return;
      }
      case 'q-review-apply': {
        // T3 — surface apply-suggestion success/error (the refresh is fired by the caller).
        const r = result as { ok?: boolean; error?: string } | null;
        setToast(r?.ok ? 'Suggestion applied to the working tree.' : `Apply failed: ${r?.error ?? 'no patch — use Ask agent to fix'}`);
        return;
      }
      case 'q-grep': if (Array.isArray(result)) setGrepHits(result as import('../../../panels/index.js').GrepHit[]); return;
      case 'q-transcript': {
        const data = result as { sessionKey?: string; rows?: Array<{ kind: string; text?: string; tools?: number; ts?: number; items?: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string; delegationState?: 'accepted' | 'not-started' }> }> };
        if (data?.sessionKey && data.sessionKey !== sessionKeyRef.current) return;
        const mapped: ChatRow[] = (data?.rows ?? []).map((r, index) => {
          // DESK-6t — use the persisted per-message timestamp so resumed history
          // shows the REAL relative time, not "just now".
          const ts = r.ts ?? Date.now();
          const stableId = getStableRowId(data.sessionKey ?? '', r, index);
          if (r.kind === 'user') return { id: stableId, kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: stableId, kind: 'assistant' as const, text: r.text ?? '', ts };
          // DESK-5p — reconstructed tool calls render as the live tool-group card.
          if (r.kind === 'tool-group') return {
            id: stableId, kind: 'tool-group' as const, ts,
            items: (r.items ?? []).map((it, itemIndex) => ({
              id: `${stableId}-item-${itemIndex}`,
              tool: it.tool,
              summary: it.summary,
              preview: it.preview,
              ok: it.ok,
              file: it.file,
              delegationState: it.delegationState,
            })),
          };
          return { id: stableId, kind: 'status' as const, text: `Used ${r.tools ?? 0} tool${(r.tools ?? 0) === 1 ? '' : 's'}`, ts };
        });
        // DESK-5u — re-inject any cached errors for this session so a failure
        // you saw earlier is still there after switching away and back.
        const cachedErrors = errorsBySession.current[data?.sessionKey ?? ''] ?? [];
        const resumeStatusId = `${data.sessionKey}-resume-status`;
        setRows([
          { id: resumeStatusId, kind: 'status', text: `Resumed ${data?.sessionKey ?? 'session'} — ${mapped.length} entries.`, ts: Date.now() },
          ...mapped,
          ...cachedErrors.map((er) => ({ id: er.id, kind: 'error' as const, text: er.text, detail: er.detail, ts: er.ts })),
        ]);
        atBottomRef.current = true;
        setAtBottom(true);
        setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: 'auto' }), 50);
        return;
      }
      // DESK-5w — a background task's conversation, opened read-only over the chat.
      case 'q-task-transcript': {
        const data = result as { id: string; kind: string; role?: string; goal?: string; status?: string; rows?: Array<{ kind: string; text?: string; ts?: number; items?: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string; delegationState?: 'accepted' | 'not-started' }> }> };
        const mapped: ChatRow[] = (data?.rows ?? []).map((r, i) => {
          const ts = r.ts ?? Date.now();
          // DESK-6v — STABLE, index-based keys: the 2.5s live poll re-sends the
          // same rows, and random ids made React remount EVERY row each time
          // (the flashing). Stable keys let it reconcile in place instead.
          if (r.kind === 'user') return { id: i, kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: i, kind: 'assistant' as const, text: r.text ?? '', ts };
          if (r.kind === 'tool-group') return {
            id: i,
            kind: 'tool-group' as const,
            ts,
            items: (r.items ?? []).map((it, j) => ({
              id: j,
              tool: it.tool,
              summary: it.summary,
              preview: it.preview,
              ok: it.ok,
              file: it.file,
              delegationState: it.delegationState,
            })),
          };
          return { id: i, kind: 'status' as const, text: r.text ?? '', ts };
        });
        // §review-visibility — a RUNNING task whose transcript is still empty
        // (the agent hasn't flushed its first line yet) must NOT erase the
        // spinner to a blank pane. Keep a stable loading row so the user sees the
        // agent is working until real content lands.
        const isTaskRunning = data?.status === 'running' || data?.status === undefined;
        const finalRows: ChatRow[] = mapped.length ? mapped : (isTaskRunning ? [{ id: 'task-working', kind: 'loading' as const, ts: 0 }] : mapped);
        // DESK-6v — and skip the state update entirely when nothing changed, so a
        // stable transcript doesn't re-render (and flash) every poll.
        const sig = (rows: ChatRow[], status?: string): string => `${status ?? ''}|` + rows.map((r) => r.kind === 'tool-group'
          ? `tg:${r.ts}:${(r.items ?? []).map((it) => `${it.tool}:${it.summary}:${it.preview ?? ''}:${it.file ?? ''}:${it.ok ? '1' : '0'}`).join(',')}`
          : `${r.kind}:${r.ts}:${(r as { text?: string }).text ?? ''}`).join('§');
        setTaskView((prev) => {
          if (!shouldApplyTaskTranscript(prev, data)) return prev;
          if (prev && sig(prev.rows, prev.status) === sig(finalRows, data.status)) return prev;
          return {
            id: data.id,
            kind: data.kind,
            role: data.role ?? prev?.role,
            title: prev?.title ?? data.goal,
            sourceKind: prev?.sourceKind,
            goal: data.goal,
            status: data.status,
            parentSessionKey: prev?.parentSessionKey,
            rows: finalRows,
          };
        });
        return;
      }
      // DESK-6w — workflow run breakdown for the /workflows-style card.
      case 'q-workflow-detail': {
        if (result && typeof result === 'object') {
          setWorkflowView((prev) => shouldApplyWorkflowDetail(prev, result as { slug?: string }) ? result as WorkflowDetail : prev);
        }
        return;
      }
      // DESK-6m — per-chat ⋮ menu action results: refresh the sidebar list.
      case 'q-session-meta': {
        if (result && typeof result === 'object' && Array.isArray((result as { groups?: unknown }).groups)) setSessionGroups((result as { groups: string[] }).groups);
        refreshSession();
        return;
      }
      case 'q-session-delete': refreshSession(); return;
      case 'q-session-fork': {
        const nk = (result as { newKey?: string } | undefined)?.newKey;
        refreshSession();
        if (nk) window.brainrouter.send({ kind: 'resume-session', sessionKey: nk });
        return;
      }
      case 'q-session-groups': if (result && typeof result === 'object' && Array.isArray((result as { groups?: unknown }).groups)) setSessionGroups((result as { groups: string[] }).groups); return;
      case 'q-open-external': return; // fire-and-forget
      case 'q-cmd': {
        const r = result as { lines?: string[]; startTurn?: string } | null;
        const lines = r && Array.isArray(r.lines) ? r.lines : [fmt(result)];
        setRows((rows) => [...rows, { id: rid(), kind: 'cmd-out', cmd: pendingCmdRef.current, lines, ts: Date.now() }]);
        // §goal-autonomy — a bridge command (e.g. /goal <text> or /goal resume)
        // can ask us to KICK OFF a turn. The prompt is hidden (machine-generated)
        // so it never renders as a message the user typed. The goal-continuation
        // loop (turn-complete → q-goalcont) takes over from there.
        if (r && typeof r.startTurn === 'string' && r.startTurn.trim()) {
          goalContPendingRef.current = null; // a fresh kickoff cancels any stale pending continuation
          window.brainrouter.send({ kind: 'start-turn', prompt: r.startTurn, hidden: true });
        }
        // A /goal command (set/resume/pause/clear) just changed the goal — refresh
        // the pinned banner so its text/status/controls reflect the new state.
        if (pendingCmdRef.current.startsWith('/goal')) q('q-goal', 'goal-state');
        return;
      }
      case 'q-goal':
        // GOAL-BANNER — the structured active goal for the pinned banner (null = none).
        setGoalState((result ?? null) as import('../../../components/chat/GoalBanner.js').GoalRecord | null);
        return;
      case 'a-goal-edit': {
        const r = result as { ok?: boolean; goal?: unknown; error?: string } | null;
        if (r && r.ok && r.goal) setGoalState(r.goal as import('../../../components/chat/GoalBanner.js').GoalRecord);
        else if (r && r.error) setToast(r.error);
        return;
      }
      case 'q-goalcont': {
        // §goal-autonomy — the host decided the goal's next move after a turn.
        const r = result as { action?: string; followUp?: string; iteration?: number; cap?: string; notice?: string } | null;
        if (!r || !r.action || r.action === 'none') return;
        if (r.action === 'continue' && typeof r.followUp === 'string') {
          const followUp = r.followUp;
          goalContPendingRef.current = followUp;
          setRows((rows) => [...rows, { id: rid(), kind: 'status', text: `🎯 Goal — continuing… send a message to steer, or pause the goal.`, ts: Date.now() }]);
          // Brief delay so a fast user message can preempt the auto-continuation.
          setTimeout(() => {
            if (goalContPendingRef.current !== followUp) return;          // canceled by user input
            if (runningSessionsRef.current.has(sessionKeyRef.current ?? '')) return; // a turn already running
            goalContPendingRef.current = null;
            window.brainrouter.send({ kind: 'start-turn', prompt: followUp, hidden: true });
          }, 600);
        } else if (r.notice) {
          setRows((rows) => [...rows, { id: rid(), kind: 'status', text: r.notice!, ts: Date.now() }]);
          // Terminal action (complete / blocked / usage_limited / halt): the
          // goal's stored status just changed, so refresh the pinned banner —
          // otherwise it stays stuck on "working" even though goal.json is done.
          // (Previously only /goal commands refreshed the banner.)
          q('q-goal', 'goal-state');
        }
        return;
      }
      case 'a-allow-rule': setToast(`Always-allow rule saved${result && typeof result === 'object' && 'rule' in (result as object) ? `: ${(result as { rule: string }).rule}` : ''} — shared with the CLI.`); q('q-snapshot', 'config-snapshot'); return;
      case 'a-learning-correct': {
        const r = result as { admitted?: boolean; rule?: string; reason?: string; item?: { id?: string } } | null;
        q('q-snapshot', 'config-snapshot');
        if (r?.admitted) setToast(`✓ Human correction recorded as an instruction${r.item?.id ? ` · ${r.item.id}` : '.'}`);
        else setToast(`✗ Correction not recorded${r?.rule ? ` (${r.rule})` : ''}: ${r?.reason ?? 'The learning gate refused it.'}`);
        return;
      }
      case 'a-learning-revert': {
        const r = result as { ok?: boolean; complete?: boolean; error?: string } | null;
        q('q-snapshot', 'config-snapshot');
        if (!r?.ok) setToast('✗ Learned behaviour was not found in the active account and organization.');
        else if (!r.complete) setToast(`⚠ Reverted locally; central-memory archive is pending${r.error ? `: ${r.error}` : '.'}`);
        else setToast('✓ Learned behaviour reverted; its skill and central-memory copy are disabled.');
        return;
      }
      case 'a-term': return; // term-exec output is rendered by the live TerminalPanel (xterm), not buffered here
      case 'a-git': {
        const r = result as { out?: string; code?: number };
        setGitBusy(false);
        const first = (r?.out ?? '').split('\n').find((l) => l.trim()) ?? '';
        setToast(r?.code ? `✗ ${first || `git exited ${r.code}`}` : `✓ ${first || 'Done'}`);
        q('q-git', 'git-info');
        q('q-files', 'changed-files');
        q('q-branches', 'git-branches');
        q('q-gitlog', 'git-log');
        q('q-pr', 'git-pr');
        return;
      }
      case 'q-recap': setInfoDialog({ title: 'Session recap', body: fmt(result) }); return;
      case 'q-chapters': {
        const marks = Array.isArray(result) ? result as Array<{ title: string; summary?: string }> : [];
        setInfoDialog({ title: 'Chapters', body: marks.length ? marks.map((m, i) => `${i + 1}. ${m.title}${m.summary ? ` — ${m.summary}` : ''}`).join('\n') : 'No chapter marks in this session yet.' });
        return;
      }
      case 'q-export': {
        const r = result as { filename?: string; content?: string };
        if (r?.filename && typeof r.content === 'string') { download(r.filename, r.content); setToast(`Exported ${r.filename}`); }
        return;
      }
      case 'a-clear': setRows([]); if (sessionKeyRef.current) delete errorsBySession.current[sessionKeyRef.current]; setToast('History cleared.'); return;
      case 'a-compact': setInfoDialog({ title: 'Compaction', body: result ? fmt(result) : 'Nothing to compact yet.' }); return;
      case 'a-mode': q('q-snapshot', 'config-snapshot'); setToast('Mode saved for this session.'); return;
      case 'a-chat-personality': q('q-snapshot', 'config-snapshot'); setToast('Personality saved for this chat.'); return;
      case 'a-pref': q('q-snapshot', 'config-snapshot'); setToast('Saved — shared with the CLI.'); return;
      case 'a-hook': q('q-snapshot', 'config-snapshot'); setToast('Hook updated.'); return;
      case 'a-ext': q('q-snapshot', 'config-snapshot'); setToast('Extension updated — reloaded.'); return;
      case 'a-trust': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { trusted?: boolean }).trusted ? 'Workspace trusted — extensions loaded.' : 'Workspace trust revoked.'); return;
      case 'a-access': setToast('Access mode set for this session.'); return;
      case 'a-reconnect': q('q-snapshot', 'config-snapshot'); setToast('Reconnect requested.'); return;
      case 'a-rule': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { ok?: boolean }).ok ? 'Permission rule saved — shared with the CLI.' : 'Could not save the rule.'); return;
      case 'a-addmcp': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { ok?: boolean; error?: string }).ok ? 'MCP server added — shared with the CLI.' : `Could not add server: ${(result as { error?: string })?.error ?? 'unknown error'}`); return;
      case 'a-rmmcp': q('q-snapshot', 'config-snapshot'); setToast('MCP server removed.'); return;
      default: return;
    }
  };
}
