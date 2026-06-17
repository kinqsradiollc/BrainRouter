/**
 * Shared renderer types: the chat row union, tool/plan items, the sidebar
 * session + fleet rows, and the workflow-detail shape. Extracted from App.tsx
 * so the chat components and the App shell agree on one definition.
 */
export type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string };
export type ToolItem = { id: number; tool: string; summary: string; preview?: string; ok: boolean; child?: string; file?: string };

export type ChatRow =
  | { id: number; kind: 'user'; text: string; ts: number }
  | { id: number; kind: 'assistant'; text: string; ts: number }
  | { id: number; kind: 'status'; text: string; ts: number }
  | { id: number; kind: 'error'; text: string; detail?: string; ts: number }
  | { id: number; kind: 'cmd-out'; cmd: string; lines: string[]; ts: number }
  | { id: number; kind: 'loading'; ts: number }
  | { id: number; kind: 'tool-group'; items: ToolItem[]; ts: number };

export interface SessionRow {
  sessionKey: string; firstUserMessage?: string; modifiedAt?: string; turnCount?: number; lastRole?: string;
  // DESK-6m — UI metadata from sessionMetaStore, merged in by list-sessions.
  pinned?: boolean; archived?: boolean; status?: 'active' | 'completed'; group?: string | null;
  // DESK-6u — parent session key this chat was forked from (null = not a fork).
  forkedFrom?: string | null;
}

// Mirrors the CLI's BackgroundTask (runtime/backgroundTasks.ts): the fleet is
// sub-agents · workers · workflows, with start time and worktree isolation.
export interface FleetRow { kind: string; id: string; label: string; startedAt?: string; role?: string; worktree?: boolean; parentSessionKey?: string | null }

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
