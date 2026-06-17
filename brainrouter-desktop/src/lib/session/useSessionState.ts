/**
 * T4 — pure session/workspace STATE container extracted verbatim from App.tsx.
 *
 * Top-of-component useState/useRef declarations for the viewed session, the
 * sidebar's session list, per-project chats, the running/finished task views,
 * the per-chat ⋮ menu, and workspace/trust state. No side effects, no ctx — the
 * App calls it once and destructures every symbol back so existing references
 * (render JSX, useAgentEvents ctx, action hooks) keep compiling unchanged.
 */
import { useRef, useState } from 'react';
import type { ChatRow, SessionRow, FleetRow, WorkflowDetail } from '../../types.js';

export interface SessionState {
  viewKey: string;
  setViewKey: React.Dispatch<React.SetStateAction<string>>;
  running: boolean;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  stopping: boolean;
  setStopping: React.Dispatch<React.SetStateAction<boolean>>;
  runningSessions: string[];
  setRunningSessions: React.Dispatch<React.SetStateAction<string[]>>;
  runningSessionsRef: React.MutableRefObject<Set<string>>;
  sessions: SessionRow[];
  setSessions: React.Dispatch<React.SetStateAction<SessionRow[]>>;
  sessionsRef: React.MutableRefObject<SessionRow[]>;
  pendingSessionsRef: React.MutableRefObject<SessionRow[]>;
  liveChildren: Record<string, { childId: string; role: string; tool?: string; startedAt: number }>;
  setLiveChildren: React.Dispatch<React.SetStateAction<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>>;
  renamingKey: string | null;
  setRenamingKey: React.Dispatch<React.SetStateAction<string | null>>;
  renameDraft: string;
  setRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  showArchived: boolean;
  setShowArchived: React.Dispatch<React.SetStateAction<boolean>>;
  sessionGroups: string[];
  setSessionGroups: React.Dispatch<React.SetStateAction<string[]>>;
  finishedTasks: Array<{ id: string; label: string; status: string }>;
  setFinishedTasks: React.Dispatch<React.SetStateAction<Array<{ id: string; label: string; status: string }>>>;
  taskView: { id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null;
  setTaskView: React.Dispatch<React.SetStateAction<{ id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null>>;
  workflowView: WorkflowDetail | null;
  setWorkflowView: React.Dispatch<React.SetStateAction<WorkflowDetail | null>>;
  sessionMenu: { key: string; x: number; y: number } | null;
  setSessionMenu: React.Dispatch<React.SetStateAction<{ key: string; x: number; y: number } | null>>;
  sessionKeyRef: React.MutableRefObject<string | undefined>;
  cardOpenRef: React.MutableRefObject<boolean>;
  errorsBySession: React.MutableRefObject<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>;
  lastPromptRef: React.MutableRefObject<string>;
  turnFailsRef: React.MutableRefObject<number>;
  workspaces: { current: string | null; recents: string[] };
  setWorkspaces: React.Dispatch<React.SetStateAction<{ current: string | null; recents: string[] }>>;
  expandedProjects: string[];
  setExpandedProjects: React.Dispatch<React.SetStateAction<string[]>>;
  expandedProjectsRef: React.MutableRefObject<string[]>;
  projSessions: Record<string, SessionRow[]>;
  setProjSessions: React.Dispatch<React.SetStateAction<Record<string, SessionRow[]>>>;
  activeWsRef: React.MutableRefObject<string | null>;
  workspaceGenRef: React.MutableRefObject<number>;
  pendingResumeRef: React.MutableRefObject<string | null>;
  trustAsk: { root: string; resume?: string } | null;
  setTrustAsk: React.Dispatch<React.SetStateAction<{ root: string; resume?: string } | null>>;
  runningWs: Set<string>;
  setRunningWs: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSessionRunning: (key: string, on: boolean) => void;
}

export function useSessionState(): SessionState {
  // `running` = the VIEWED session has a turn in flight (drives the composer).
  const [running, setRunning] = useState(false);
  // DESK-6 — Stop was pressed and we're waiting for the turn to actually unwind.
  // Gives immediate visual feedback (the old code only fired IPC and showed a
  // volatile status line that the next 'Thinking…' overwrote). Cleared when the
  // turn really ends (turn-complete/turn-error) or on a session switch.
  const [stopping, setStopping] = useState(false);
  // DESK-5v — CONCURRENT SESSIONS: every session key with a turn in flight, so
  // switching away never stops a turn and the sidebar shows a spinner on each
  // chat that's still working. `running` above is just "is the viewed one in
  // this set". Ref mirror so the persistent onEvent listener reads live state.
  const runningSessionsRef = useRef<Set<string>>(new Set());
  const [runningSessions, setRunningSessions] = useState<string[]>([]);
  // DESK-5w — the viewed session key as REACTIVE state (sessionKeyRef is the
  // ref mirror). Drives session-scoped background-task views.
  const [viewKey, setViewKey] = useState<string>('');
  const setSessionRunning = (key: string, on: boolean): void => {
    const s = runningSessionsRef.current;
    if (on) s.add(key); else s.delete(key);
    setRunningSessions([...s]);
  };
  // Stability item 4 — which WORKSPACES (projects) currently have a turn in
  // flight, including ones not on screen. The host pool keeps that work alive
  // in the background; this lets the sidebar show a "running" dot on other
  // projects so the user knows it didn't vanish when they switched away.
  const [runningWs, setRunningWs] = useState<Set<string>>(() => new Set());
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  // DESK-5n — in-turn child agents (workers/sub-agents) live ONLY in the
  // streamed child-* events, never in the disk-backed fleet the host polls,
  // so the Background-tasks panel was blind to them mid-turn. Track them live
  // here keyed by childId; upsert on child-tool-start/end, drop on complete.
  const [liveChildren, setLiveChildren] = useState<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>({});
  // DESK-6m — per-chat ⋮ context menu + its sub-flows.
  const [sessionMenu, setSessionMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sessionGroups, setSessionGroups] = useState<string[]>([]);
  const sessionsRef = useRef<SessionRow[]>([]);
  // Wave 2 — optimistic new-chat rows not yet confirmed by the host's
  // list-sessions. Kept across refreshes (merged) so a fresh chat's row never
  // flickers out while the transcript flush races the refresh.
  const pendingSessionsRef = useRef<SessionRow[]>([]);
  const lastPromptRef = useRef('');
  // T2/T3 — the workspace the on-screen surfaces belong to, set authoritatively
  // by session-changed. Events tagged with a DIFFERENT workspace are dropped so
  // one project's stream can never paint into another's surfaces.
  const activeWsRef = useRef<string | null>(null);
  // Stability fix — workspace GENERATION: bumped on every workspace switch so
  // late async query results from the previous project are dropped, never
  // painting workspace A's data into workspace B's surfaces.
  const workspaceGenRef = useRef(0);
  // DESK-5u — current viewed session key, kept in a ref so the (mount-once)
  // event handler can read it without going stale.
  const sessionKeyRef = useRef<string | undefined>(undefined);
  // DESK-5u — error cards aren't part of the persisted transcript, so cache
  // them per session here and re-inject on resume — a turn failure stays
  // visible when you switch away and come back.
  const errorsBySession = useRef<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>({});
  // DESK-6w — true while a read-only card view (task convo / workflow) is open,
  // so the transcript auto-scroll never yanks the card down on a refresh.
  const cardOpenRef = useRef(false);
  const turnFailsRef = useRef(0);
  const [finishedTasks, setFinishedTasks] = useState<Array<{ id: string; label: string; status: string }>>([]);
  // DESK-5w — the background task whose conversation is open (read-only),
  // shown in place of the chat. null = normal chat view.
  const [taskView, setTaskView] = useState<{ id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null>(null);
  // DESK-6w — a workflow run's breakdown (Claude /workflows-style card), shown
  // in place of the chat when you click a workflow background task.
  const [workflowView, setWorkflowView] = useState<WorkflowDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<{ current: string | null; recents: string[] }>({ current: null, recents: [] });
  // DESK-5d — the trust gate runs BEFORE a project opens (and before a chat
  // in another project resumes); `resume` carries the chat to land on.
  const [trustAsk, setTrustAsk] = useState<{ root: string; resume?: string } | null>(null);
  // DESK-5d — per-project chat histories + expansion (lazy-fetched), the
  // current branch's PR chip, and the chat to resume after a host swap.
  const [projSessions, setProjSessions] = useState<Record<string, SessionRow[]>>({});
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const expandedProjectsRef = useRef<string[]>([]);
  const pendingResumeRef = useRef<string | null>(null);

  return {
    viewKey, setViewKey, running, setRunning, stopping, setStopping,
    runningSessions, setRunningSessions, runningSessionsRef,
    sessions, setSessions, sessionsRef, pendingSessionsRef,
    liveChildren, setLiveChildren, renamingKey, setRenamingKey, renameDraft, setRenameDraft,
    showArchived, setShowArchived, sessionGroups, setSessionGroups,
    finishedTasks, setFinishedTasks, taskView, setTaskView, workflowView, setWorkflowView,
    sessionMenu, setSessionMenu, sessionKeyRef, cardOpenRef, errorsBySession, lastPromptRef, turnFailsRef,
    workspaces, setWorkspaces, expandedProjects, setExpandedProjects, expandedProjectsRef, projSessions, setProjSessions,
    activeWsRef, workspaceGenRef, pendingResumeRef, trustAsk, setTrustAsk, runningWs, setRunningWs,
    setSessionRunning,
  };
}
