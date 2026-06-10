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
  | { kind: 'plan-update'; items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>; explanation?: string }
  | { kind: 'compaction'; droppedMessages: number; keptMessages: number; summary: string }
  | { kind: 'memory'; level: 'info' | 'warn'; text: string }
  | { kind: 'approval-decision'; tool: string; action: string; decision: 'allow' | 'ask' | 'deny'; reason?: string }
  | { kind: 'interaction-request'; request: InteractionRequest }
  | { kind: 'turn-complete'; answer: string }
  | { kind: 'turn-error'; message: string }
  | { kind: 'tokens-updated'; promptTokens: number; completionTokens: number; calls: number; turns: number }
  | { kind: 'session-changed'; sessionKey: string; loadedMessages: number; model: string }
  | { kind: 'query-result'; id: string; ok: boolean; result?: unknown; error?: string };

export type AgentEventMessage = EventEnvelope & { event: AgentEvent };

const EVENT_KINDS = new Set<string>([
  'turn-start', 'status', 'assistant-turn-start', 'assistant-delta', 'assistant-turn-end',
  'reasoning-delta', 'tool-start', 'tool-end', 'child-tool-start', 'child-tool-end',
  'child-complete', 'plan-update', 'compaction', 'memory', 'approval-decision',
  'interaction-request', 'turn-complete', 'turn-error', 'tokens-updated', 'session-changed', 'query-result',
]);

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

export type AgentCommand =
  | { kind: 'start-turn'; prompt: string }
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
  onToolStart: (tool: string, args: Record<string, unknown>, callId?: string) => void;
  onToolEnd: (tool: string, result: { success: boolean; summary: string; preview?: string }, callId?: string) => void;
  onAssistantTurnStart: () => void;
  onAssistantDelta: (chunk: string) => void;
  onAssistantTurnEnd: () => void;
  onReasoningDelta: (chunk: string) => void;
  onPlanUpdate: (items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>, explanation?: string) => void;
  onCompactionEvent: (event: { droppedMessages: number; keptMessages: number; summary: string }) => void;
  onMemoryEvent: (event: { kind?: string; level?: 'info' | 'warn'; text?: string; reason?: string }) => void;
  onApproval: (event: { tool: string; action: string; decision: 'allow' | 'ask' | 'deny'; reason?: string }) => void;
  onChildToolStart: (event: { childId: string; role: string; tool: string; args: Record<string, unknown> }) => void;
  onChildToolEnd: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }) => void;
  onChildComplete: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }) => void;
}

/** Emitter the bridge writes to — the host wraps IPC/stdout behind this. */
export type EmitEvent = (event: AgentEvent) => void;

/** Build RunTurnCallbacks that translate every callback into protocol events. Pure. */
export function createCallbackBridge(emit: EmitEvent): BridgedCallbacks {
  return {
    onStatusUpdate: (text) => emit({ kind: 'status', text }),
    onToolStart: (tool, args, callId) => emit({ kind: 'tool-start', tool, args: args ?? {}, callId }),
    onToolEnd: (tool, result, callId) =>
      emit({ kind: 'tool-end', tool, ok: result.success, summary: result.summary, preview: result.preview, callId }),
    onAssistantTurnStart: () => emit({ kind: 'assistant-turn-start' }),
    onAssistantDelta: (text) => emit({ kind: 'assistant-delta', text }),
    onAssistantTurnEnd: () => emit({ kind: 'assistant-turn-end' }),
    onReasoningDelta: (text) => emit({ kind: 'reasoning-delta', text }),
    onPlanUpdate: (items, explanation) => emit({ kind: 'plan-update', items, explanation }),
    onCompactionEvent: (event) => emit({ kind: 'compaction', ...event }),
    onMemoryEvent: (event) =>
      emit({ kind: 'memory', level: event.level ?? 'info', text: event.text ?? event.reason ?? String(event.kind ?? '') }),
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
