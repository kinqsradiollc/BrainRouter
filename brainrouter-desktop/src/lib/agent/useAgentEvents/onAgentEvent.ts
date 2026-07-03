/**
 * onAgentEvent — the `window.brainrouter.onEvent` callback body extracted from
 * useAgentEvents.ts byte-identically. Built as a factory that closes over the
 * hook's `AgentEventsCtx`, the two per-turn refs, and the query-result router,
 * exactly as the original in-effect closure did. `push`/`pushTool`/
 * `flushAssistant` are rebuilt here (unchanged) so the switch stays identical.
 */
import type React from 'react';
import type { AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import type { ToolItem, ChatRow } from '../../../types.js';
import {
  isStaleWorkspaceEvent, isBlockedDuringPendingWorkspaceSwitch, nextActiveWorkspace,
  workspaceChanged, parseQueryId, nextRunningWorkspaces,
} from '../../workspace/workspaceEvents.js';
import { sessionRowsCacheKey } from '../../session/list/sessionCache.js';
import { fileFromSummary } from '../../format.js';
import { FOREGROUND_ONLY_KINDS } from '../../../constants.js';
import { rid } from '../../rid.js';
import { type AgentEventsCtx, isWorkspaceScopedReviewQuery } from './types.js';

export interface OnAgentEventDeps {
  ctx: AgentEventsCtx;
  streamedThisTurnRef: React.MutableRefObject<boolean>;
  turnEditsRef: React.MutableRefObject<Map<string, string>>;
  handleQueryResult: (rawId: string, result: unknown, error?: string, resultWorkspaceRoot?: string) => void;
}

export function createOnAgentEvent(deps: OnAgentEventDeps): (msg: AgentEventMessage) => void {
  const { ctx, streamedThisTurnRef, turnEditsRef, handleQueryResult } = deps;
  const {
    setRows, setRunning, setStopping, setTurnStart, setStatusLine, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setGoalState, setPlanHistory, setTokens, setLiveTurn, setEfficiency, setTrack, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, planFeedbackRef, goalContPendingRef, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setRecentTasks, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setToolCatalog, setProviderModels, setProbedModels, setProbeLoading, setProbeError, setCatalog, setSnapshot, setUsageLines, setUsageHistory,
    setSearchHits, setSchedules, setRequirements, setAnnotations, setArtifacts, setAtlasGraph, setAtlasBuilding, setAtlasEnriching, setAtlasAssessing, setAtlasAssessments, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setFilesLoading, setFilesTruncated, setFilesError, setAttachmentUploads,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingWorkspaceRef, pendingResumeRef, errorsBySession, lastPromptRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef, cachedSessionRowsRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  } = ctx;
  // The destructuring above mirrors the hook so the moved handler body stays
  // byte-identical; ids the event switch doesn't touch are harmless (noUnusedLocals
  // is off). Reference the unused ones once so linters/bundlers don't prune them.
  void setGoalState; void setPlanHistory; void setTrack; void setProjSessions; void setSessions;
  void setPrInfo; void setFleet; void setRecentTasks; void setChangedFiles; void setDiffView;
  void setInlineDiffs; void setAllFiles; void setFileView; void setGitInfo; void setCommitSubjects;
  void setHomeStats; void setBranches; void setModelsLoading; void setEndpointModels; void setToolCatalog;
  void setProviderModels; void setProbedModels; void setProbeLoading; void setProbeError; void setCatalog;
  void setSnapshot; void setUsageLines; void setUsageHistory; void setSchedules; void setRequirements;
  void setAnnotations; void setArtifacts; void setAtlasBuilding; void setAtlasEnriching; void setWorktrees;
  void setWorktreeDiffs; void setReviewRunningByWs; void setReviewByWs; void setReviewGateByWs;
  void setGateBlock; void setGrepHits; void setSessionGroups; void setGitBusy;
  void setFilesLoading; void setFilesTruncated; void setFilesError; void setAttachmentUploads;
  void planFeedbackRef; void pendingGitRef; void pendingCmdRef; void gitInfo; void homeStats; void branches;
  void runGit; void isWorkspaceScopedReviewQuery;

  const push = (row: ChatRow) => setRows((r) => [...r, row]);
  const pushTool = (item: ToolItem) => setRows((r) => {
    const last = r[r.length - 1];
    if (last && last.kind === 'tool-group') {
      return [...r.slice(0, -1), { ...last, items: [...last.items, item] }];
    }
    return [...r, { id: rid(), kind: 'tool-group', items: [item], ts: Date.now() }];
  });
  const flushAssistant = () => {
    const text = liveBuf.current.trim();
    liveBuf.current = '';
    liveFlushPending.current = false;
    setLiveText('');
    if (text) push({ id: rid(), kind: 'assistant', text, ts: Date.now() });
  };
  return (msg: AgentEventMessage) => {
    // T2/T3 — main tags each event with its owning workspace. Drop events from
    // a non-active workspace generation, then let session-changed advance the
    // active workspace. Untagged events (single-host) pass through unchanged.
    const wsMsg = msg as AgentEventMessage & { workspaceRoot?: string };
    const prevWs = activeWsRef.current;
    // Item 4 — record per-WORKSPACE running state BEFORE the stale-drop below:
    // a background project's turn events are exactly what that drop discards,
    // and they're what powers the sidebar's "running elsewhere" dot.
    setRunningWs((s) => nextRunningWorkspaces(s, msg.event?.kind, wsMsg.workspaceRoot));
    // WS3 — per-SESSION running state must also update for EVERY workspace, not
    // just the active one: a session running in a PARKED workspace otherwise
    // shows a stale spinner (its turn-lifecycle events are exactly what the
    // stale-drop below discards). Mirror the per-workspace capture above and do
    // it BEFORE the drop, keyed by the event's OWNING session.
    {
      const owning = msg.sessionKey;
      const k = msg.event?.kind;
      if (owning) {
        if (k === 'turn-start') setSessionRunning(owning, true);
        else if (k === 'turn-complete' || k === 'turn-error') setSessionRunning(owning, false);
      }
    }
    const pendingWorkspace = pendingWorkspaceRef.current;
    if (pendingWorkspace && msg.event?.kind === 'query-result') {
      const queryEvent = msg.event as { id?: string; ok?: boolean; result?: unknown; error?: string };
      const id = typeof queryEvent.id === 'string' ? parseQueryId(queryEvent.id).base : '';
      if (wsMsg.workspaceRoot && isWorkspaceScopedReviewQuery(id)) {
        handleQueryResult(queryEvent.id!, queryEvent.ok ? queryEvent.result : undefined, queryEvent.ok ? undefined : queryEvent.error, wsMsg.workspaceRoot);
      }
      return;
    }
    if (isBlockedDuringPendingWorkspaceSwitch(wsMsg, pendingWorkspace)) return;
    if (isStaleWorkspaceEvent(wsMsg, prevWs)) return;
    activeWsRef.current = nextActiveWorkspace(wsMsg, prevWs);
    setHostUp(true);
    const e: AgentEvent = msg.event;
    // DESK-5v — route by session: a turn you started can keep running after
    // you switch chats; its events stay tagged with ITS key. Drop the purely
    // visual ones when they're not for the chat on screen.
    const currentSessionKey = sessionKeyRef.current || info.sessionKey || '';
    const owningSessionKey = msg.sessionKey || currentSessionKey;
    const isForeground = !currentSessionKey || !owningSessionKey || owningSessionKey === currentSessionKey;
    if (!isForeground && FOREGROUND_ONLY_KINDS.has(e.kind)) return;
    switch (e.kind) {
      case 'status': setStatusLine(e.text); break;
      case 'reasoning-delta': setReasoningTail((t) => t + e.text); break;
      case 'assistant-turn-start': liveBuf.current = ''; liveFlushPending.current = false; setLiveText(''); break;
      case 'assistant-delta':
        streamedThisTurnRef.current = true;
        liveBuf.current += e.text;
        if (!liveFlushPending.current) {
          liveFlushPending.current = true;
          setTimeout(() => { liveFlushPending.current = false; setLiveText(liveBuf.current); }, 60);
        }
        break;
      case 'assistant-turn-end': flushAssistant(); break;
      case 'tool-end': {
        if (!e.ok) turnFailsRef.current += 1;
        const editedFile = fileFromSummary(e.tool, e.summary);
        if (e.ok && editedFile) turnEditsRef.current.set(editedFile, /write|create/i.test(e.tool) ? 'A' : 'M');
        pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, file: editedFile });
        setToolLog((t) => [...t.slice(-199), { id: rid(), tool: e.tool, ok: e.ok, summary: e.summary }]);
        // §AV-3 — near-live artifacts: when the agent authors/updates an artifact
        // in-band (artifact_write), refresh the list immediately so the Artifacts
        // panel reflects it mid-turn instead of waiting for a manual reload.
        if (e.ok && e.tool === 'artifact_write') q('q-art', 'artifact-list');
        break;
      }
      case 'child-tool-start':
        // DESK-5n — first sign of a live child: register it as running.
        setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
        break;
      case 'child-tool-end': {
        const childEdit = fileFromSummary(e.tool, e.summary);
        if (e.ok && childEdit) turnEditsRef.current.set(childEdit, /write|create/i.test(e.tool) ? 'A' : 'M');
        pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, child: `${e.role}·${e.childId.slice(-4)}` });
        // Keep the live entry fresh (covers children whose first seen event is an end).
        setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
        break;
      }
      case 'child-complete':
        push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '✓' : '✗'} agent ${e.childId} (${e.role}) ${e.status}`, ts: Date.now() });
        setFinishedTasks((f) => [...f.slice(-30), { id: e.childId, label: `${e.role}·${e.childId.slice(-4)}`, status: e.status === 'completed' ? 'Agent · Completed' : 'Agent · Failed' }]);
        setLiveChildren((m) => { const n = { ...m }; delete n[e.childId]; return n; });
        break;
      case 'plan-update':
        setLastPlan({ items: e.items, explanation: e.explanation });
        push({ id: rid(), kind: 'status', text: 'Updated the plan', action: 'plan', ts: Date.now() });
        break;
      case 'files-changed':
        // FILES-LIVE — the host's debounced fs.watch fired. Re-pull the file
        // tree (cache already invalidated host-side), the Changes list and the
        // git counts so the right panel stays live without a manual Refresh.
        // The stale-workspace guard above already dropped events for a
        // background workspace, so this only repaints the foreground one.
        q('q-list', 'list-files', { refresh: true });
        q('q-files', 'changed-files');
        q('q-git', 'git-info');
        break;
      case 'compaction': push({ id: rid(), kind: 'status', text: `Compacted ${e.droppedMessages} → kept ${e.keptMessages}`, ts: Date.now() }); setEfficiency((s) => ({ ...s, compactions: s.compactions + 1, droppedMessages: s.droppedMessages + (e.droppedMessages || 0) })); q('q-ctx', 'context-usage'); break;
      case 'memory':
        // A briefing carries the recalled records — render a collapsible row
        // that shows the user exactly what memory was injected, not a label.
        if ((e as { op?: string }).op === 'briefing') {
          const briefRecords = (e as { records?: import('../../../types.js').BriefingRecord[] }).records ?? [];
          push({ id: rid(), kind: 'briefing', sources: (e as { sources?: string[] }).sources ?? [], records: briefRecords, ts: Date.now() });
          if (briefRecords.length) setEfficiency((s) => ({ ...s, memoriesRecalled: s.memoriesRecalled + briefRecords.length }));
        } else {
          push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.text}`, ts: Date.now() });
        }
        break;
      // §truncation — a persistent provider-truncation notice ("raise cli.maxOutputTokens").
      case 'notice': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.message}`, ts: Date.now() }); break;
      case 'requirement-event':
        q('q-req', 'requirement-list');
        break;
      case 'annotation-event':
        q('q-annot', 'annotation-list');
        break;
      case 'artifact-event':
        q('q-art', 'artifact-list');
        break;
      case 'provenance':
        break;
      case 'task-event': {
        // DURABLE BACKGROUND TASKS — a plan-revision/review/attachment task
        // changed state. Refresh the fleet so the Background panel + sidebar
        // indicators update instantly (don't wait for the 3s poll). Failures
        // stay out of the chat transcript; the task panel owns background work.
        q('q-fleet', 'fleet');
        // A terminal task event also refreshes the recently-finished list so a
        // just-completed/failed verification appears without waiting for the poll.
        if (e.action === 'completed' || e.action === 'failed' || e.action === 'canceled') {
          q('q-tasks-recent', 'tasks-list', { scope: 'workspace', status: 'all' });
        }
        if (e.action === 'failed' && e.task?.error) {
          setToast(`${e.task.title}: ${e.task.error}`);
        }
        break;
      }
      case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns, cachedTokens: e.cachedTokens }); setLiveTurn(null); q('q-ctx', 'context-usage'); break;
      // LIVE — per-call cumulative usage for THIS turn (set, don't add: the agent
      // sends the turn's running total). The session base (`tokens`) absorbs it at
      // turn-end, where setLiveTurn(null) above keeps the two from double-counting.
      case 'usage-live': if (isForeground) { setLiveTurn({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, calls: e.calls, cachedTokens: e.cachedTokens }); q('q-ctx', 'context-usage'); } break;
      case 'interaction-request': setInteraction(e.request); setPicked([]); break;
      case 'session-changed':
        // DESK-5u — session-changed is the authoritative "current session"
        // signal; track it directly (info.sessionKey can be clobbered by a
        // q-info refresh, which would mis-bucket per-session errors).
        pendingWorkspaceRef.current = null;
        sessionKeyRef.current = e.sessionKey;
        setViewKey(e.sessionKey);
        setTaskView(null); setWorkflowView(null); // DESK-5w/6w — leaving closes any open task/workflow view
        // DESK-5v — the composer reflects whether the chat we just landed on
        // is itself running (it may be — a background turn you started here
        // earlier). Clear the transient per-turn surfaces either way.
        // Reconcile the per-session running flag against the host's
        // AUTHORITATIVE state (Runtime.running, carried on session-changed). A
        // dropped turn-complete (workspace stale-drop / host exit for a
        // non-foreground session) used to leave runningSessionsRef stuck → a
        // resumed chat showed "working…" forever with a bogus 600s+ elapsed.
        // When the host reports running, trust it: clear or set the ref.
        const hostRunning = typeof e.running === 'boolean'
          ? e.running
          : runningSessionsRef.current.has(e.sessionKey);
        if (typeof e.running === 'boolean') setSessionRunning(e.sessionKey, e.running);
        setRunning(hostRunning);
        // Reset the elapsed clock — turnStart is only written by submit(), so a
        // resumed/backgrounded turn (or a stale flag) showed minutes from an
        // unrelated turn. If it really is running we don't know the original
        // start, so count from now (honest-ish); if not, the spinner is hidden.
        setTurnStart(hostRunning ? Date.now() : 0);
        setStopping(false); // DESK-6 — a switch clears any pending stop indicator
        setStatusLine(''); setReasoningTail(''); setLiveText(''); liveBuf.current = '';
        // Session-scoped surfaces must NOT carry over from the chat we just left:
        // reset the context meter + plan now (the refresh below repopulates them
        // from THIS session's data — a new chat → empty, not the old chat's 100%).
        setContextUsage(null); setLastPlan(null); setPlanHistory([]);
        setEfficiency({ compactions: 0, droppedMessages: 0, memoriesRecalled: 0 }); // efficiency is per-session
        if (e.loadedMessages > 0) {
          // Only show spinner if not cached
          const cacheRoot = wsMsg.workspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
          if (!cachedSessionRowsRef.current || !cachedSessionRowsRef.current[sessionRowsCacheKey(cacheRoot, e.sessionKey)]) {
            setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
          }
          setSearchHits(null);
          q('q-transcript', 'transcript', { sessionKey: e.sessionKey });
        } else if (e.loadedMessages === 0) {
          setRows([]);
          setSearchHits(null);
          setTimeout(() => { if (chatRef.current) chatRef.current.scrollTop = 0; }, 50);
        }
        // T3 — identity is set ATOMICALLY here from the event's own workspace,
        // so breadcrumb / env / sidebar all flip to the new project in one go
        // instead of lagging behind a separate session-info refresh.
        setInfo((i) => ({ ...i, sessionKey: e.sessionKey, model: e.model || i.model, workspaceRoot: wsMsg.workspaceRoot ?? i.workspaceRoot }));
        if (wsMsg.workspaceRoot) setWorkspaces((w) => w.current === wsMsg.workspaceRoot ? w : { ...w, current: wsMsg.workspaceRoot! });
        // DESK-5d — a chat clicked under ANOTHER project: the new host has
        // just announced itself; now land on the chat that was clicked.
        {
          const want = pendingResumeRef.current;
          if (want) {
            pendingResumeRef.current = null;
            if (e.sessionKey !== want) window.brainrouter.send({ kind: 'resume-session', sessionKey: want });
          }
        }
        // The effort / mode chip reads its value from the config snapshot,
        // which is SESSION-aware on the host (resolveActiveMode). It's fetched
        // at boot / Settings-open / mode-mutations but NOT on session switch,
        // so the chip used to show the PREVIOUS session's effort while the
        // agent (which resolves fresh per turn) sent this session's. Refetch
        // it on every switch so the chip matches what actually gets sent.
        q('q-snapshot', 'config-snapshot');
        // GOAL-BANNER — pull THIS session's active goal so the pinned banner
        // reflects the chat we just landed on (each session has its own goal).
        q('q-goal', 'goal-state');
        // Stability fix — refresh tier by whether the WORKSPACE changed: a
        // project/workspace switch needs the FULL git/workspace refresh so
        // branches + git state reload (they were cleared on switch); a same-
        // workspace session change (new chat / switch chat) only needs the
        // light refresh (git is identical across chats in one workspace).
        if (workspaceChanged(wsMsg.workspaceRoot, prevWs)) {
          // ATLAS-18 — the Atlas is per-workspace. Drop the previous project's
          // graph and load the NEW workspace's STORED graph (q-atlas reads, never
          // regenerates), so its prior enrichment is preserved until the user
          // explicitly Rebuilds/Enriches. Clear transient + path-keyed state too.
          setAtlasGraph(null); setAtlasBuilding(false); setAtlasEnriching(false);
          setAtlasAssessing(null); setAtlasAssessments({});
          q('q-atlas', 'atlas-graph');
          refreshSidebar();
        } else refreshSession();
        break;
      // DESK-5v — turn lifecycle is tracked PER SESSION so a background turn
      // keeps its spinner and lands its result/error in the right chat.
      case 'turn-start': if (owningSessionKey) setSessionRunning(owningSessionKey, true); if (isForeground) { setRunning(true); setTurnStart(Date.now()); setLiveTurn(null); streamedThisTurnRef.current = false; turnEditsRef.current = new Map(); } break;
      case 'turn-complete': {
        if (owningSessionKey) setSessionRunning(owningSessionKey, false);
        if (!isForeground) { refreshSidebar(); break; } // background turn: its answer is on disk, re-read on switch-back
        flushAssistant();
        // Render the final answer UNLESS this turn already streamed/flushed one.
        // (The old guard checked "does any assistant row exist?" — true after any
        // earlier turn — so a non-streaming endpoint's answer was dropped from the
        // live view until a session reload.)
        if (!streamedThisTurnRef.current && (e.answer ?? '').trim()) {
          push({ id: rid(), kind: 'assistant', text: e.answer, ts: Date.now() });
        }
        streamedThisTurnRef.current = false;
        setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
        setLastTurnFails(turnFailsRef.current);
        setLiveChildren({}); // turn ended — refreshSidebar reseeds any detached workers
        refreshSidebar();
        // End-of-turn changeset — if the agent edited files this turn, ask the
        // host for their numstat; the result handler appends a Codex-style
        // "Edited N files +X −Y" card right after the final answer.
        if (turnEditsRef.current.size > 0) {
          q('q-turn-changeset', 'turn-changeset', { paths: [...turnEditsRef.current.keys()] });
          turnEditsRef.current = new Map();
        }
        // §goal-autonomy — ask the host whether an active goal should continue.
        // Returns { action:'none' } (a no-op) when there's no goal, so this is
        // safe on every turn. A 'continue' result fires the next hidden turn.
        q('q-goalcont', 'goal-continuation');
        break;
      }
      case 'turn-error': {
        if (owningSessionKey) setSessionRunning(owningSessionKey, false);
        // DESK-5u/5v — record the error under the SESSION IT BELONGS TO (not
        // the one on screen) so it survives a switch-away-and-back, and a
        // background failure shows up when you return to that chat.
        const errId = rid();
        const errText = 'Something went wrong';
        const errSession = owningSessionKey;
        if (errSession) {
          const bucket = errorsBySession.current[errSession] ?? [];
          errorsBySession.current[errSession] = [...bucket.slice(-19), { id: errId, text: errText, detail: e.message, ts: Date.now() }];
        }
        if (!isForeground) { refreshSidebar(); break; } // surfaces on switch-back via q-transcript re-injection
        flushAssistant();
        push({ id: errId, kind: 'error', text: errText, detail: e.message, ts: Date.now() });
        setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
        setLiveChildren({}); setLiveTurn(null); // a failed turn never gets tokens-updated; clear live
        // Observed: the app preserves your message on failure.
        setDraft((d) => d || lastPromptRef.current);
        break;
      }
      case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined, e.ok ? undefined : (e as { error?: string }).error, wsMsg.workspaceRoot); break;
      default: break;
    }
    // Sticky-bottom: never yank the view while the user is reading scrollback.
    queueMicrotask(() => { if (atBottomRef.current && !cardOpenRef.current) chatEnd.current?.scrollIntoView({ behavior: 'auto' }); });
  };
}
