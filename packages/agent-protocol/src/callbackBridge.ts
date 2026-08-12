/**
 * Runtime-callback to protocol-event adapter.
 *
 * The structural callback mirror keeps the protocol independent of Core and
 * CLI while giving every host one event projection.
 */

import type {
  AgentEvent,
  BriefingRecord,
  ProfileStageEventView,
  PeerSessionSenderEventView,
  ProvenanceRef,
  RecordLifecycleAction,
  SteeringReceiptEventView,
} from './events.js';
import type { ChildExecutionReceipt } from './delegation.js';
import type { PlanPhaseView, PlanStepView } from './planning.js';

export interface BridgedCallbacks {
  onStatusUpdate: (text: string) => void;
  onNotice: (notice: { level: 'info' | 'warn'; message: string }) => void;
  onSteerApplied: (
    input: {
      id: string;
      text: string;
      source: 'user' | 'extension' | 'peer-session';
      createdAt: number;
      sender?: PeerSessionSenderEventView;
    },
    receipt: SteeringReceiptEventView,
  ) => void;
  onSteerExpired: (input: {
    id: string;
    text: string;
    source: 'peer-session';
    createdAt: number;
    sender: PeerSessionSenderEventView;
  }) => void;
  onSteerReceipt: (receipt: SteeringReceiptEventView) => void;
  onSessionTitle: (event: { title: string; source: 'agent' | 'hook' | 'human' | 'derived' }) => void;
  onToolStart: (tool: string, args: Record<string, unknown>, callId?: string) => void;
  onToolEnd: (
    tool: string,
    result: {
      success: boolean;
      summary: string;
      preview?: string;
      delegationState?: 'accepted' | 'not-started';
    },
    callId?: string,
  ) => void;
  onAssistantTurnStart: () => void;
  onAssistantDelta: (chunk: string) => void;
  onAssistantTurnEnd: () => void;
  onReasoningDelta: (chunk: string) => void;
  onPlanUpdate: (
    items: PlanStepView[],
    explanation?: string,
    state?: { revision?: number; phases?: PlanPhaseView[] },
  ) => void;
  onProfileStageUpdate: (event: ProfileStageEventView) => void;
  onCompactionEvent: (event: { droppedMessages: number; keptMessages: number; summary: string }) => void;
  onUsageUpdate: (usage: { promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number; missedTokens?: number }) => void;
  onMemoryEvent: (event: { kind?: string; level?: 'info' | 'warn'; text?: string; reason?: string; sources?: string[]; recordCount?: number; records?: BriefingRecord[] }) => void;
  onRequirementEvent: (event: { action: RecordLifecycleAction; requirementId: string; title?: string; status?: string; provenance?: ProvenanceRef }) => void;
  onArtifactEvent: (event: { action: RecordLifecycleAction; artifactId: string; title?: string; status?: string; format?: string; path?: string; version?: number; provenance?: ProvenanceRef }) => void;
  onAnnotationEvent: (event: { action: RecordLifecycleAction; annotationId: string; targetKind: string; targetId?: string; status?: string; provenance?: ProvenanceRef }) => void;
  onProvenanceEvent: (event: { subjectKind: 'requirement' | 'artifact' | 'annotation' | 'plan' | 'memory' | 'tool' | 'session'; subjectId?: string; provenance: ProvenanceRef }) => void;
  onApproval: (event: { tool: string; action: string; decision: 'allow' | 'ask' | 'deny'; reason?: string }) => void;
  onChildToolStart: (event: { childId: string; role: string; tool: string; args: Record<string, unknown> }) => void;
  onChildToolEnd: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }) => void;
  onChildComplete: (receipt: ChildExecutionReceipt) => void;
}

/** Emitter the bridge writes to—the host wraps IPC/stdout behind this. */
export type EmitEvent = (event: AgentEvent) => void;

/** Build callbacks that translate every supported runtime callback into a protocol event. */
export function createCallbackBridge(emit: EmitEvent): BridgedCallbacks {
  return {
    onStatusUpdate: (text) => emit({ kind: 'status', text }),
    onNotice: (notice) => emit({ kind: 'notice', level: notice.level, message: notice.message }),
    onSteerApplied: (input, receipt) => emit({
      kind: 'input-delivery',
      id: input.id,
      mode: 'steer',
      state: 'applied',
      text: input.text,
      source: input.source,
      ...(input.sender ? { sender: { ...input.sender } } : {}),
      receipt,
    }),
    onSteerExpired: (input) => emit({
      kind: 'input-delivery',
      id: input.id,
      mode: 'steer',
      state: 'expired',
      text: input.text,
      source: input.source,
      sender: { ...input.sender },
    }),
    onSteerReceipt: (receipt) => emit({ kind: 'steering-receipt', receipt }),
    onSessionTitle: (event) => emit({ kind: 'session-title', ...event }),
    onUsageUpdate: (usage) => emit({
      kind: 'usage-live',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      calls: usage.calls,
      cachedTokens: usage.cachedTokens,
    }),
    onToolStart: (tool, args, callId) => emit({ kind: 'tool-start', tool, args: args ?? {}, callId }),
    onToolEnd: (tool, result, callId) =>
      emit({
        kind: 'tool-end',
        tool,
        ok: result.success,
        summary: result.summary,
        preview: result.preview,
        callId,
        delegationState: result.delegationState,
      }),
    onAssistantTurnStart: () => emit({ kind: 'assistant-turn-start' }),
    onAssistantDelta: (text) => emit({ kind: 'assistant-delta', text }),
    onAssistantTurnEnd: () => emit({ kind: 'assistant-turn-end' }),
    onReasoningDelta: (text) => emit({ kind: 'reasoning-delta', text }),
    onPlanUpdate: (items, explanation, state) => emit({
      kind: 'plan-update',
      items,
      explanation,
      revision: state?.revision,
      phases: state?.phases,
    }),
    onProfileStageUpdate: (event) => emit({ kind: 'profile-stage', ...event }),
    onCompactionEvent: (event) => emit({ kind: 'compaction', ...event }),
    onMemoryEvent: (event) => {
      if (event.kind === 'briefing') {
        const sources = event.sources ?? [];
        const records = event.records ?? [];
        const count = event.recordCount ?? records.length;
        emit({
          kind: 'memory',
          level: 'info',
          op: 'briefing',
          sources,
          records,
          text: `Briefing · ${count} ${count === 1 ? 'memory' : 'memories'}${sources.length ? ` · ${sources.join(', ')}` : ''}`,
        });
        return;
      }
      emit({
        kind: 'memory',
        level: event.level ?? 'info',
        text: event.text ?? event.reason ?? String(event.kind ?? ''),
      });
    },
    onRequirementEvent: (event) => emit({ kind: 'requirement-event', ...event }),
    onArtifactEvent: (event) => emit({ kind: 'artifact-event', ...event }),
    onAnnotationEvent: (event) => emit({ kind: 'annotation-event', ...event }),
    onProvenanceEvent: (event) => emit({ kind: 'provenance', ...event }),
    onApproval: (event) => emit({ kind: 'approval-decision', ...event }),
    onChildToolStart: (event) => emit({ kind: 'child-tool-start', ...event }),
    onChildToolEnd: (event) => emit({ kind: 'child-tool-end', ...event }),
    onChildComplete: (receipt) => emit({
      kind: 'child-complete',
      receipt,
      childId: receipt.childId,
      role: receipt.role,
      status: receipt.status,
      preview: receipt.preview,
      error: receipt.error,
    }),
  };
}
