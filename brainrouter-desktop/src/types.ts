/**
 * Shared renderer types: the chat row union, tool/plan items, the sidebar
 * session + fleet rows, and the workflow-detail shape. Extracted from App.tsx
 * so the chat components and the App shell agree on one definition.
 */
/** Composer / header popover ids (which menu is open). */
export type PopId = '' | 'mode' | 'model' | 'effort' | 'ctx' | 'export' | 'branch' | 'plus' | 'splus' | 'bplus' | 'repo' | 'local' | 'commit' | 'title' | 'editor';

export type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string };
export type ToolItem = { id: number | string; tool: string; summary: string; preview?: string; ok: boolean; child?: string; file?: string };

export type ChatRow =
  | { id: number | string; kind: 'user'; text: string; ts: number }
  | { id: number | string; kind: 'assistant'; text: string; ts: number }
  | { id: number | string; kind: 'status'; text: string; ts: number }
  | { id: number | string; kind: 'error'; text: string; detail?: string; ts: number }
  | { id: number | string; kind: 'cmd-out'; cmd: string; lines: string[]; ts: number }
  | { id: number | string; kind: 'loading'; ts: number }
  | { id: number | string; kind: 'tool-group'; items: ToolItem[]; ts: number };

export interface SessionRow {
  sessionKey: string; firstUserMessage?: string; modifiedAt?: string; turnCount?: number; lastRole?: string;
  // DESK-6m — UI metadata from sessionMetaStore, merged in by list-sessions.
  pinned?: boolean; archived?: boolean; status?: 'active' | 'completed'; group?: string | null;
  // DESK-6u — parent session key this chat was forked from (null = not a fork).
  forkedFrom?: string | null;
}

// Mirrors the CLI's BackgroundTask (runtime/backgroundTasks.ts): the fleet is
// sub-agents · workers · workflows, with start time and worktree isolation.
export interface FleetRow {
  kind: string; id: string; label: string; startedAt?: string; role?: string; worktree?: boolean; parentSessionKey?: string | null;
  /** DURABLE background tasks (plan-revision/review/verification/attachment) carry these. */
  durable?: boolean;
  status?: string;
  phase?: string;
  requirementId?: string;
  planId?: string;
  transcript?: { kind: string; id: string; parentSessionKey?: string };
}

export interface AttachmentUpload {
  id: string;
  name: string;
  size: number;
  status: 'reading' | 'attaching' | 'attached' | 'failed';
  detail?: string;
  attachmentId?: string;
  kind?: string;
  contextMarkdown?: string;
}

export interface TaskViewState {
  id: string;
  kind: string;
  role?: string;
  title?: string;
  sourceKind?: string;
  goal?: string;
  status?: string;
  parentSessionKey?: string | null;
  rows: ChatRow[];
}

// DESK-6w — a workflow run's full breakdown, mirroring Claude Code's /workflows
// card: phases, each with the child agents it spawned and their token/tool/time.
export interface WorkflowAgent { id: string; label: string; role: string; status: string; tokens: number; tools: number; ms: number }
export interface WorkflowPhase { id: string; title: string; status: string; agents: WorkflowAgent[] }
export interface WorkflowDetail {
  slug: string; kind: string; status: string; startedAt: string; updatedAt: string;
  totalAgents: number; totalTokens: number;
  phases: WorkflowPhase[];
  steps: Array<{ id: string; title: string; status: string }>;
}
