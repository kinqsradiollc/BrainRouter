/**
 * DESK-0 (0.4.15 thread M) — the BrainRouter agent protocol.
 *
 * ONE typed vocabulary for everything a presentation head needs to talk to the
 * agent runtime: the Ink TUI consumes these as in-process callbacks, the CLI's
 * `run --format jsonl` prints them as lines, and the Desktop app ships them
 * over Electron IPC (renderer ⇄ main ⇄ utilityProcess agent host). The event
 * shapes mirror `RunTurnCallbacks` in `brainrouter-cli` — defined structurally
 * here (no dependency on the CLI package) so the protocol stays the leaf.
 *
 * Zero runtime deps; hand-rolled guards in repo style. Everything pure.
 */

// ---------------------------------------------------------------------------
// Events — agent host → presentation head
// ---------------------------------------------------------------------------

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

/** What happened to a background task (gap 1/2/3). */
export type TaskEventAction = 'created' | 'progress' | 'updated' | 'completed' | 'failed' | 'canceled';

/**
 * Compact, wire-stable view of a durable background task (plan revision,
 * review, verification, attachment, workflow, agent). Structurally a subset of
 * the CLI/types `BackgroundTaskRecord` so the host can pass a record straight
 * through; the protocol stays a leaf (no dependency on the types package).
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

export type AgentEvent =
  | { kind: 'turn-start'; prompt: string }
  | { kind: 'status'; text: string }
  | { kind: 'assistant-turn-start' }
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'assistant-turn-end' }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'tool-start'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-end'; tool: string; ok: boolean; summary: string; preview?: string; callId?: string }
  | { kind: 'child-tool-start'; childId: string; role: string; tool: string; args: Record<string, unknown> }
  | { kind: 'child-tool-end'; childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }
  | { kind: 'child-complete'; childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }
  | { kind: 'plan-update'; items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string }>; explanation?: string }
  | { kind: 'compaction'; droppedMessages: number; keptMessages: number; summary: string }
  | { kind: 'memory'; level: 'info' | 'warn'; text: string; op?: string; sources?: string[]; records?: BriefingRecord[] }
  | { kind: 'requirement-event'; action: RecordLifecycleAction; requirementId: string; title?: string; status?: string; provenance?: ProvenanceRef }
  | { kind: 'artifact-event'; action: RecordLifecycleAction; artifactId: string; title?: string; status?: string; format?: string; path?: string; version?: number; provenance?: ProvenanceRef }
  | { kind: 'annotation-event'; action: RecordLifecycleAction; annotationId: string; targetKind: string; targetId?: string; status?: string; provenance?: ProvenanceRef }
  | { kind: 'provenance'; subjectKind: 'requirement' | 'artifact' | 'annotation' | 'plan' | 'memory' | 'tool' | 'session'; subjectId?: string; provenance: ProvenanceRef }
  | { kind: 'task-event'; action: TaskEventAction; task: BackgroundTaskEventView; provenance?: ProvenanceRef }
  | { kind: 'approval-decision'; tool: string; action: string; decision: 'allow' | 'ask' | 'deny'; reason?: string }
  | { kind: 'interaction-request'; request: InteractionRequest }
  | { kind: 'turn-complete'; answer: string }
  | { kind: 'turn-error'; message: string }
  | { kind: 'tokens-updated'; promptTokens: number; completionTokens: number; calls: number; turns: number; cachedTokens?: number }
  // LIVE per-LLM-call usage for the CURRENT turn (fires after each call, not just
  // at turn-end) so the UI's token counter ticks up live instead of snapshotting.
  // cachedTokens = prompt tokens served from the provider cache (a cost saving).
  | { kind: 'usage-live'; promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number }
  | { kind: 'session-changed'; sessionKey: string; loadedMessages: number; model: string; running?: boolean }
  // A PERSISTENT, turn-scoped notice the agent wants on the record (not a
  // transient status line) — e.g. the provider truncated the reply at its token
  // cap. Rendered as a durable status row, mirroring the CLI.
  | { kind: 'notice'; level: 'info' | 'warn'; message: string }
  // The workspace filesystem changed (debounced host fs.watch) — the renderer
  // re-runs its file/changes/git queries so the Files panel stays live.
  | { kind: 'files-changed' }
  | { kind: 'query-result'; id: string; ok: boolean; result?: unknown; error?: string };

export type AgentEventMessage = EventEnvelope & { event: AgentEvent };

const EVENT_KINDS = new Set<string>([
  'turn-start', 'status', 'assistant-turn-start', 'assistant-delta', 'assistant-turn-end',
  'reasoning-delta', 'tool-start', 'tool-end', 'child-tool-start', 'child-tool-end',
  'child-complete', 'plan-update', 'compaction', 'memory', 'requirement-event',
  'artifact-event', 'annotation-event', 'provenance', 'task-event', 'approval-decision',
  'interaction-request', 'turn-complete', 'turn-error', 'tokens-updated', 'usage-live', 'session-changed', 'query-result',
  'notice', 'files-changed',
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

// ---------------------------------------------------------------------------
// Commands — presentation head → agent host
// ---------------------------------------------------------------------------

/**
 * An image sent inline with a turn (pasted screenshot / attached picture), for
 * vision-capable models. `dataBase64` is the raw base64 payload WITHOUT the
 * `data:<mime>;base64,` prefix; `mediaType` is the MIME type (e.g. image/png).
 */
export interface AgentImage {
  mediaType: string;
  dataBase64: string;
}

export type AgentCommand =
  | { kind: 'start-turn'; prompt: string; hidden?: boolean; images?: AgentImage[] }
  | { kind: 'interrupt' }
  | { kind: 'interaction-response'; id: string; response: InteractionResponse }
  | { kind: 'query'; id: string; name: string; args?: Record<string, unknown> }
  | { kind: 'new-session'; label?: string }
  | { kind: 'resume-session'; sessionKey: string }
  | { kind: 'set-model'; model: string; persist?: boolean }
  | { kind: 'shutdown' };

const COMMAND_KINDS = new Set<string>(['start-turn', 'interrupt', 'interaction-response', 'query', 'new-session', 'resume-session', 'set-model', 'shutdown']);

/** Structural guard for a wire-decoded command. Pure. */
export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === 'string' && COMMAND_KINDS.has(v.kind);
}

// ---------------------------------------------------------------------------
// Interaction port — the TTY seams (approvals / choices), made injectable
// ---------------------------------------------------------------------------

export type InteractionRequest =
  | { id: string; type: 'confirm'; title: string; detail?: string; dangerous?: boolean; tool?: string }
  | {
      id: string;
      type: 'choice';
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    };

export type InteractionResponse =
  | { type: 'confirm'; approved: boolean }
  | { type: 'choice'; labels: string[] }
  | { type: 'dismissed' };

/**
 * What the agent runtime calls when it needs a human decision. The CLI
 * implements this with readline prompts; the Desktop host implements it by
 * emitting `interaction-request` and awaiting the matching
 * `interaction-response` command (see InteractionBroker).
 */
export interface InteractionPort {
  confirm(req: { title: string; detail?: string; dangerous?: boolean; tool?: string }): Promise<boolean>;
  choice(req: {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }): Promise<string[] | null>;
}

/**
 * Pure request/response correlator for transports where the answer arrives as
 * a separate message. `request()` registers a pending interaction and returns
 * its wire request + promise; `resolve()` settles it. Timeouts settle with
 * `{ type: 'dismissed' }` so the agent's deny-by-default paths fire instead of
 * hanging a turn forever.
 */
export class InteractionBroker {
  private pending = new Map<string, { resolve: (r: InteractionResponse) => void; timer?: ReturnType<typeof setTimeout> }>();
  private counter = 0;

  request(
    req: Omit<Extract<InteractionRequest, { type: 'confirm' }>, 'id'> | Omit<Extract<InteractionRequest, { type: 'choice' }>, 'id'>,
    opts?: { timeoutMs?: number },
  ): { request: InteractionRequest; response: Promise<InteractionResponse> } {
    const id = `ir_${++this.counter}`;
    const request = { ...req, id } as InteractionRequest;
    const response = new Promise<InteractionResponse>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) resolve({ type: 'dismissed' });
        }, opts.timeoutMs);
      }
      this.pending.set(id, { resolve, timer });
    });
    return { request, response };
  }

  /** Settle a pending interaction. Returns false for unknown/already-settled ids. */
  resolve(id: string, response: InteractionResponse): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  /** Settle EVERYTHING as dismissed (host shutdown / turn interrupt). */
  dismissAll(): number {
    let n = 0;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ type: 'dismissed' });
      this.pending.delete(id);
      n += 1;
    }
    return n;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Callback bridge — RunTurnCallbacks (structural) → protocol events
// ---------------------------------------------------------------------------

/**
 * Structural mirror of the CLI's `RunTurnCallbacks` — the agent host passes
 * the object returned by `createCallbackBridge` straight into
 * `agent.runTurn(prompt, callbacks)` and every callback becomes a protocol
 * event. Optional callbacks the runtime doesn't fire simply never emit.
 */
export interface BridgedCallbacks {
  onStatusUpdate: (text: string) => void;
  onNotice: (notice: { level: 'info' | 'warn'; message: string }) => void;
  onToolStart: (tool: string, args: Record<string, unknown>, callId?: string) => void;
  onToolEnd: (tool: string, result: { success: boolean; summary: string; preview?: string }, callId?: string) => void;
  onAssistantTurnStart: () => void;
  onAssistantDelta: (chunk: string) => void;
  onAssistantTurnEnd: () => void;
  onReasoningDelta: (chunk: string) => void;
  onPlanUpdate: (items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string }>, explanation?: string) => void;
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
  onChildComplete: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }) => void;
}

/** Emitter the bridge writes to — the host wraps IPC/stdout behind this. */
export type EmitEvent = (event: AgentEvent) => void;

/** Build RunTurnCallbacks that translate every callback into protocol events. Pure. */
/** One recalled memory surfaced in a pre-turn briefing — enough for the UI to
 *  show the user WHAT was injected (id / type / priority / content preview). */
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

export function createCallbackBridge(emit: EmitEvent): BridgedCallbacks {
  return {
    onStatusUpdate: (text) => emit({ kind: 'status', text }),
    onNotice: (notice) => emit({ kind: 'notice', level: notice.level, message: notice.message }),
    // LIVE token usage: forward the agent's per-call usage so the UI ticks up
    // during the turn (the session total still lands via tokens-updated at end).
    onUsageUpdate: (usage) => emit({ kind: 'usage-live', promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, calls: usage.calls, cachedTokens: usage.cachedTokens }),
    onToolStart: (tool, args, callId) => emit({ kind: 'tool-start', tool, args: args ?? {}, callId }),
    onToolEnd: (tool, result, callId) =>
      emit({ kind: 'tool-end', tool, ok: result.success, summary: result.summary, preview: result.preview, callId }),
    onAssistantTurnStart: () => emit({ kind: 'assistant-turn-start' }),
    onAssistantDelta: (text) => emit({ kind: 'assistant-delta', text }),
    onAssistantTurnEnd: () => emit({ kind: 'assistant-turn-end' }),
    onReasoningDelta: (text) => emit({ kind: 'reasoning-delta', text }),
    onPlanUpdate: (items, explanation) => emit({ kind: 'plan-update', items, explanation }),
    onCompactionEvent: (event) => emit({ kind: 'compaction', ...event }),
    onMemoryEvent: (event) => {
      // A pre-turn briefing carries the actual recalled records — pass them
      // through structured (op + sources + records) so the desktop can render a
      // collapsible "what memory was injected" view, not a bare "briefing" label.
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
      emit({ kind: 'memory', level: event.level ?? 'info', text: event.text ?? event.reason ?? String(event.kind ?? '') });
    },
    onRequirementEvent: (event) => emit({ kind: 'requirement-event', ...event }),
    onArtifactEvent: (event) => emit({ kind: 'artifact-event', ...event }),
    onAnnotationEvent: (event) => emit({ kind: 'annotation-event', ...event }),
    onProvenanceEvent: (event) => emit({ kind: 'provenance', ...event }),
    onApproval: (event) => emit({ kind: 'approval-decision', ...event }),
    onChildToolStart: (event) => emit({ kind: 'child-tool-start', ...event }),
    onChildToolEnd: (event) => emit({ kind: 'child-tool-end', ...event }),
    onChildComplete: (event) => emit({ kind: 'child-complete', ...event }),
  };
}

/**
 * Stateful envelope writer: stamps seq + ts + sessionKey onto raw events.
 * One per session stream; seq starts at 1.
 */
export function createEnvelopeWriter(
  sessionKey: string,
  send: (msg: AgentEventMessage) => void,
  now: () => number = () => Date.now(),
): EmitEvent {
  let seq = 0;
  return (event) => send({ seq: ++seq, ts: now(), sessionKey, event });
}
