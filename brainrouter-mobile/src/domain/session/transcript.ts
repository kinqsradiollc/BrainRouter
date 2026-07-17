/**
 * Transcript reducer — the pure spine of the Session screen (S-03). It folds the
 * agent event stream (AgentEvent, technical-doc §6) into a flat, render-ready
 * transcript plus the turn's running / plan / tokens / pending-approval state.
 *
 * The desktop built this in renderer React state; on mobile it's an isolated
 * pure function so the streaming + tool-correlation logic is unit-testable
 * without React Native, and so MockTransport and RemoteTransport drive the
 * identical model. Row ids derive from the envelope `seq` (monotonic per
 * session) → deterministic and stable as list keys. Tool rows are correlated to
 * their `tool-start` by `callId`. The store layer (state/sessionStore) owns the
 * transport subscription and clears `pendingInteraction` once the user answers.
 */
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import { parseThink } from '../parse/thinkParse.js';

export type ToolStatus = 'running' | 'ok' | 'error';

/** One render-ready transcript row. */
export type TranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'reasoning'; text: string; streaming: boolean }
  | { id: string; kind: 'tool'; callId: string; tool: string; args: Record<string, unknown>; status: ToolStatus; summary?: string; preview?: string }
  | { id: string; kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface PlanState {
  items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string }>;
  explanation?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  turns: number;
  cachedTokens?: number;
}

export interface TranscriptState {
  items: TranscriptItem[];
  /** A turn is in flight (composer shows Stop instead of Send). */
  running: boolean;
  /** Transient one-line status (cleared at turn end); not a transcript row. */
  statusText: string | null;
  /** Latest plan snapshot (Plan screen S-06 reads this). */
  plan: PlanState | null;
  /** Latest token usage for the session/turn. */
  tokens: TokenUsage | null;
  /** An approval/choice awaiting the user (drives the approval sheet S-05). */
  pendingInteraction: InteractionRequest | null;
  /** Active model id (from session-changed). */
  model: string | null;
  /** Raw text accumulated across CONSECUTIVE assistant-deltas — the source for
   *  inline `<think>` extraction (reasoning models stream chain-of-thought in the
   *  answer). Reset whenever the delta run ends. Not rendered. */
  assistantRaw: string;
  /** Seq anchoring the current streaming assistant message's row ids, so the
   *  reasoning/answer rows keep stable keys as the buffer re-parses. */
  assistantSeq: number | null;
}

/** A fresh, empty transcript (new or just-switched session). */
export function emptyTranscript(): TranscriptState {
  return {
    items: [],
    running: false,
    statusText: null,
    plan: null,
    tokens: null,
    pendingInteraction: null,
    model: null,
    assistantRaw: '',
    assistantSeq: null,
  };
}

type StreamingKind = 'assistant' | 'reasoning';

/** Append delta text to the trailing streaming row of `kind`, else open `fresh`. */
function appendStreaming(state: TranscriptState, kind: StreamingKind, text: string, fresh: TranscriptItem): TranscriptState {
  const last = state.items[state.items.length - 1];
  if (last && (last.kind === 'assistant' || last.kind === 'reasoning') && last.kind === kind && last.streaming) {
    const updated = { ...last, text: last.text + text };
    return { ...state, items: [...state.items.slice(0, -1), updated] };
  }
  return { ...state, items: [...state.items, fresh] };
}

/** Stop every streaming assistant/reasoning row (the turn ended). */
function clearStreaming(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((i) => (i.kind === 'assistant' || i.kind === 'reasoning' ? { ...i, streaming: false } : i));
}

/** Finalize streaming rows at a turn boundary: stop streaming AND drop empty
 *  assistant/reasoning rows — the placeholder opened before any text arrived, or
 *  a whitespace-only `<think>` block (parseThink trims, so these go to ''). */
function finalize(items: TranscriptItem[]): TranscriptItem[] {
  return clearStreaming(items).filter(
    (i) => !((i.kind === 'assistant' || i.kind === 'reasoning') && i.text.trim() === ''),
  );
}

/** The recall step raises this turn-error on the FIRST turn of a fresh session
 *  (no prior transcript on disk yet). It's non-fatal — the turn still runs — so it
 *  must not surface as a red error notice in the chat. */
function isBenignTurnError(message: string): boolean {
  return /^\s*No transcript found\b/i.test(message);
}

/** Resolve the running tool row matching `callId`, or append a completed one. */
function endTool(state: TranscriptState, event: Extract<AgentEvent, { kind: 'tool-end' }>, seq: number): TranscriptState {
  const idx = state.items.findIndex((i) => i.kind === 'tool' && i.callId === event.callId && i.status === 'running');
  if (idx === -1) {
    const callId = event.callId ?? `t${seq}`;
    const row: TranscriptItem = { id: callId, kind: 'tool', callId, tool: event.tool, args: {}, status: event.ok ? 'ok' : 'error', summary: event.summary, preview: event.preview };
    return { ...state, items: [...state.items, row] };
  }
  const items = state.items.slice();
  const row = items[idx];
  if (row.kind === 'tool') {
    items[idx] = { ...row, status: event.ok ? 'ok' : 'error', summary: event.summary, preview: event.preview };
  }
  return { ...state, items };
}

/** Fold one agent event message into the transcript. Pure — never mutates input. */
export function reduceTranscript(incoming: TranscriptState, msg: AgentEventMessage): TranscriptState {
  const { event, seq } = msg;
  // The raw assistant-delta buffer (for inline <think> parsing) spans only
  // CONSECUTIVE deltas. status/usage/tokens/plan can interleave harmlessly; any
  // other event ends the run and clears the buffer.
  const continuesRun =
    event.kind === 'assistant-delta' ||
    event.kind === 'status' ||
    event.kind === 'usage-live' ||
    event.kind === 'tokens-updated' ||
    event.kind === 'plan-update';
  const state =
    continuesRun || (incoming.assistantRaw === '' && incoming.assistantSeq === null)
      ? incoming
      : { ...incoming, assistantRaw: '', assistantSeq: null };
  switch (event.kind) {
    case 'turn-start':
      return { ...state, running: true, statusText: null, items: [...state.items, { id: `u${seq}`, kind: 'user', text: event.prompt }] };
    case 'status':
      return { ...state, statusText: event.text };
    case 'assistant-turn-start':
      return { ...state, assistantSeq: seq, items: [...state.items, { id: `a${seq}`, kind: 'assistant', text: '', streaming: true }] };
    case 'assistant-delta': {
      // Accumulate the raw answer and re-derive the leading <think> split each
      // delta, so reasoning streams into its own row and the answer bubble stays
      // clean (Qwen et al. emit chain-of-thought inline). Rows keep stable ids
      // anchored to `assistantSeq`; only THIS message's rows are rebuilt.
      const anchor = state.assistantSeq ?? seq;
      const raw = state.assistantRaw + event.text;
      const parsed = parseThink(raw);
      const aId = `a${anchor}`;
      const rId = `r${anchor}`;
      let end = state.items.length;
      while (end > 0) {
        const r = state.items[end - 1];
        if ((r.kind === 'assistant' || r.kind === 'reasoning') && r.streaming && (r.id === aId || r.id === rId)) end--;
        else break;
      }
      const rows: TranscriptItem[] = state.items.slice(0, end);
      if (parsed.hadThink && parsed.reasoning) rows.push({ id: rId, kind: 'reasoning', text: parsed.reasoning, streaming: true });
      if (parsed.visible !== '' || !parsed.hadThink) rows.push({ id: aId, kind: 'assistant', text: parsed.visible, streaming: true });
      return { ...state, assistantRaw: raw, assistantSeq: anchor, items: rows };
    }
    case 'reasoning-delta':
      return appendStreaming(state, 'reasoning', event.text, { id: `r${seq}`, kind: 'reasoning', text: event.text, streaming: true });
    case 'assistant-turn-end':
      return { ...state, items: finalize(state.items) };
    case 'tool-start': {
      const callId = event.callId ?? `t${seq}`;
      return { ...state, items: [...state.items, { id: callId, kind: 'tool', callId, tool: event.tool, args: event.args, status: 'running' }] };
    }
    case 'tool-end':
      return endTool(state, event, seq);
    case 'plan-update':
      return { ...state, plan: { items: event.items, explanation: event.explanation } };
    case 'interaction-request':
      return { ...state, pendingInteraction: event.request };
    case 'tokens-updated':
      return { ...state, tokens: { promptTokens: event.promptTokens, completionTokens: event.completionTokens, calls: event.calls, turns: event.turns, cachedTokens: event.cachedTokens } };
    case 'usage-live':
      return { ...state, tokens: { promptTokens: event.promptTokens, completionTokens: event.completionTokens, calls: event.calls, turns: state.tokens?.turns ?? 0, cachedTokens: event.cachedTokens } };
    case 'session-changed':
      return { ...state, model: event.model, running: event.running ?? state.running };
    case 'turn-complete':
      return { ...state, running: false, statusText: null, items: finalize(state.items) };
    case 'turn-error': {
      const items = finalize(state.items);
      // The first-turn recall miss is benign — stop the turn but don't show it.
      if (isBenignTurnError(event.message)) return { ...state, running: false, statusText: null, items };
      const notice: TranscriptItem = { id: `e${seq}`, kind: 'notice', level: 'error', text: event.message };
      return { ...state, running: false, statusText: null, items: [...items, notice] };
    }
    case 'notice':
      return { ...state, items: [...state.items, { id: `n${seq}`, kind: 'notice', level: event.level, text: event.message }] };
    case 'compaction':
      return { ...state, items: [...state.items, { id: `k${seq}`, kind: 'notice', level: 'info', text: `Compacted ${event.droppedMessages} messages (kept ${event.keptMessages})` }] };
    default:
      return state;
  }
}
