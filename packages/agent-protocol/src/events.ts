/**
 * Agent-host events sent to a presentation head.
 *
 * These wire-stable records are structural subsets of runtime records. They
 * deliberately avoid importing Core, CLI, host, or persistence packages.
 */

import type { InteractionRequest } from './interaction.js';
import type { AssuranceRunEventAction, AssuranceRunEventView } from './assurance.js';

export interface EventEnvelope {
  /** Monotonic per-session sequence (gap detection over lossy transports). */
  seq: number;
  /** ms epoch at emit time. */
  ts: number;
  /** Session this event belongs to (one host can multiplex workspaces). */
  sessionKey: string;
}

export type RecordLifecycleAction =
  | 'created'
  | 'updated'
  | 'status-changed'
  | 'comment-added'
  | 'linked-memory'
  | 'exported'
  | 'saved'
  | 'reverted';

export interface ProvenanceRef {
  sourceEventId?: string;
  linkedMemoryIds?: string[];
  actor?: string;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface ProfileStageEventView {
  phase: 'resolved' | 'updated' | 'terminated';
  profileId: string;
  strategyId: string;
  selectionSource: 'explicit' | 'adaptive-model' | 'deterministic' | 'fallback';
  stages: Array<{
    id: string;
    state: 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
    executor: 'primary' | 'role';
    roleId?: string;
    skillIds: string[];
    activeSkillId?: string;
  }>;
}

/** What happened to a background task (gap 1/2/3). */
export type TaskEventAction = 'created' | 'progress' | 'updated' | 'completed' | 'failed' | 'canceled';

/**
 * Compact, wire-stable view of a durable background task. Structurally a subset
 * of the shared record so hosts can pass it through while this package remains
 * a dependency leaf.
 */
export interface BackgroundTaskEventView {
  id: string;
  kind: string;
  status: string;
  title: string;
  workspaceRoot: string;
  sessionKey: string;
  requirementId?: string;
  planId?: string;
  artifactId?: string;
  attachmentId?: string;
  /** How to open the task's transcript/conversation/workflow. */
  transcript?: { kind: string; id: string; parentSessionKey?: string };
  /** Current phase name, when running. */
  phase?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}

/** One recalled memory surfaced in a pre-turn briefing. */
export interface BriefingRecord {
  id: string;
  type?: string;
  priority?: number;
  content?: string;
  /** Which briefing source surfaced this record (e.g. memory_recall). */
  source?: string;
  /** Relevance score when the source provides one. */
  score?: number;
}

/** Browser-safe projection of the shared Work Contract steering receipt. */
export interface SteeringReceiptEventView {
  id: string;
  source: 'user' | 'parent' | 'extension';
  classification?: 'clarification' | 'plan_change' | 'evidence' | 'goal_conflict';
  receivedAt: string;
  appliedAt?: string;
  priorRevision: number;
  resultingRevision?: number;
  affectedRequirementIds: string[];
  affectedTaskIds: string[];
  summary: string;
  status: 'pending' | 'applied' | 'rejected' | 'needs_user';
}

export type AgentEvent =
  | { kind: 'turn-start'; prompt: string }
  | { kind: 'status'; text: string }
  | { kind: 'assistant-turn-start' }
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'assistant-turn-end' }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'tool-start'; tool: string; args: Record<string, unknown>; callId?: string }
  | {
      kind: 'tool-end';
      tool: string;
      ok: boolean;
      summary: string;
      preview?: string;
      callId?: string;
      delegationState?: 'accepted' | 'not-started';
    }
  | { kind: 'child-tool-start'; childId: string; role: string; tool: string; args: Record<string, unknown> }
  | { kind: 'child-tool-end'; childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }
  | { kind: 'child-complete'; childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }
  | { kind: 'plan-update'; items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string }>; explanation?: string }
  | ({ kind: 'profile-stage' } & ProfileStageEventView)
  | { kind: 'compaction'; droppedMessages: number; keptMessages: number; summary: string }
  | { kind: 'memory'; level: 'info' | 'warn'; text: string; op?: string; sources?: string[]; records?: BriefingRecord[] }
  | { kind: 'requirement-event'; action: RecordLifecycleAction; requirementId: string; title?: string; status?: string; provenance?: ProvenanceRef }
  | { kind: 'artifact-event'; action: RecordLifecycleAction; artifactId: string; title?: string; status?: string; format?: string; path?: string; version?: number; provenance?: ProvenanceRef }
  | { kind: 'annotation-event'; action: RecordLifecycleAction; annotationId: string; targetKind: string; targetId?: string; status?: string; provenance?: ProvenanceRef }
  | { kind: 'provenance'; subjectKind: 'requirement' | 'artifact' | 'annotation' | 'plan' | 'memory' | 'tool' | 'session'; subjectId?: string; provenance: ProvenanceRef }
  | { kind: 'task-event'; action: TaskEventAction; task: BackgroundTaskEventView; provenance?: ProvenanceRef }
  | { kind: 'assurance-run'; action: AssuranceRunEventAction; run: AssuranceRunEventView; provenance?: ProvenanceRef }
  | { kind: 'approval-decision'; tool: string; action: string; decision: 'allow' | 'ask' | 'deny'; reason?: string }
  | { kind: 'interaction-request'; request: InteractionRequest }
  | { kind: 'turn-complete'; answer: string }
  | { kind: 'turn-error'; message: string }
  | {
      kind: 'input-delivery';
      id: string;
      mode: 'queue' | 'steer';
      state: 'queued' | 'steered' | 'applied' | 'running' | 'completed' | 'canceled';
      text: string;
      position?: number;
      source?: 'user' | 'extension';
      receipt?: SteeringReceiptEventView;
    }
  | { kind: 'steering-receipt'; receipt: SteeringReceiptEventView }
  | { kind: 'tokens-updated'; promptTokens: number; completionTokens: number; calls: number; turns: number; cachedTokens?: number }
  | { kind: 'usage-live'; promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number }
  | { kind: 'session-changed'; sessionKey: string; loadedMessages: number; model: string; running?: boolean }
  | { kind: 'notice'; level: 'info' | 'warn'; message: string }
  | { kind: 'files-changed' }
  | { kind: 'query-result'; id: string; ok: boolean; result?: unknown; error?: string };

export type AgentEventMessage = EventEnvelope & { event: AgentEvent };

const EVENT_KINDS = new Set<string>([
  'turn-start', 'status', 'assistant-turn-start', 'assistant-delta', 'assistant-turn-end',
  'reasoning-delta', 'tool-start', 'tool-end', 'child-tool-start', 'child-tool-end',
  'child-complete', 'plan-update', 'profile-stage', 'compaction', 'memory', 'requirement-event',
  'artifact-event', 'annotation-event', 'provenance', 'task-event', 'approval-decision',
  'interaction-request', 'turn-complete', 'turn-error', 'tokens-updated', 'usage-live',
  'session-changed', 'query-result', 'notice', 'files-changed', 'input-delivery',
  'steering-receipt',
  'assurance-run',
]);

/** Structural guard for a {@link BackgroundTaskEventView}. Pure. */
export function isBackgroundTaskEventView(value: unknown): value is BackgroundTaskEventView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.status === 'string' &&
    typeof v.title === 'string' &&
    typeof v.workspaceRoot === 'string' &&
    typeof v.sessionKey === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

/** Structural guard for a wire-decoded event message. Pure. */
export function isAgentEventMessage(value: unknown): value is AgentEventMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== 'number' || typeof v.ts !== 'number' || typeof v.sessionKey !== 'string') return false;
  const ev = v.event as Record<string, unknown> | undefined;
  return !!ev && typeof ev.kind === 'string' && EVENT_KINDS.has(ev.kind);
}
