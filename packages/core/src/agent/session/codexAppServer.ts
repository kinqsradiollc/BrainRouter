/**
 * ADR-050 P2b — the Codex `app-server` transport (JSON-RPC over stdio).
 *
 * Lifecycle: `initialize` → `thread/start` (or `thread/resume <thread_id>`) →
 * per prompt a `turn/start` request whose RESPONSE is the turn boundary, while
 * `codex/event` notifications stream assistant text and tool activity in between;
 * `turn/interrupt` cancels. The `thread_id` is the `resumeCursor`.
 *
 * The event NORMALIZER is a pure function tested against the app-server event
 * shapes; field names track the published `codex-rs/app-server-protocol` and are
 * the one thing to confirm against the installed CLI (a live-verification step,
 * not a design question).
 */
import { JsonRpcStdio } from './jsonRpcStdio.js';
import type {
  AgentSessionDeps,
  AgentSessionEvent,
  AgentSessionHandlers,
  AgentSessionPort,
  AgentSessionSpec,
  AgentSessionTurn,
  SessionStopReason,
} from './types.js';

export type CodexNormalized = { t: 'text'; text: string; final?: boolean } | { t: 'tool'; name: string };

/** Pure: normalize a `codex/event` notification's inner message. */
export function normalizeCodexEvent(params: unknown): CodexNormalized[] {
  const out: CodexNormalized[] = [];
  const outer = params as Record<string, any> | undefined;
  const msg = (outer && typeof outer === 'object' && outer.msg && typeof outer.msg === 'object' ? outer.msg : outer) as Record<string, any> | undefined;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return out;
  switch (msg.type) {
    case 'agent_message_delta':
      if (typeof msg.delta === 'string') out.push({ t: 'text', text: msg.delta });
      break;
    case 'agent_message':
      if (typeof msg.message === 'string') out.push({ t: 'text', text: msg.message, final: true });
      break;
    case 'exec_command_begin':
    case 'exec_command_start':
      out.push({ t: 'tool', name: typeof msg.command === 'string' ? msg.command : 'command' });
      break;
    case 'mcp_tool_call_begin':
      out.push({ t: 'tool', name: typeof msg.tool === 'string' ? msg.tool : 'tool' });
      break;
  }
  return out;
}

interface CodexTurn {
  onEvent: (e: AgentSessionEvent) => void;
  text: string;
  sawDelta: boolean;
  done: boolean;
  settledReason?: SessionStopReason;
}

export class CodexAppServerSession implements AgentSessionPort {
  readonly transport = 'codex-app-server' as const;
  private _resumeCursor?: string;
  private rpc?: JsonRpcStdio;
  private stderr = '';
  private turn?: CodexTurn;

  constructor(private readonly spec: AgentSessionSpec, private readonly deps: AgentSessionDeps = {}) {
    this._resumeCursor = spec.resumeCursor;
  }

  get resumeCursor(): string | undefined { return this._resumeCursor; }

  async open(): Promise<void> {
    if (this.rpc?.running) return;
    this.rpc = new JsonRpcStdio(
      this.spec.command, ['app-server'],
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onStderr: (t) => { this.stderr += t; },
        onExit: () => this.settle('error', this.stderr.trim() || 'codex app-server exited'),
        onError: (err) => this.settle('error', err.message),
      },
      { ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}), ...(this.spec.env ? { env: this.spec.env } : {}) },
      this.deps,
    );
    this.rpc.start();
    await this.rpc.request('initialize', { clientInfo: { name: 'brainrouter', version: '1' } });
    if (this._resumeCursor) {
      await this.rpc.request('thread/resume', { thread_id: this._resumeCursor });
    } else {
      const started = await this.rpc.request<{ thread_id?: string; threadId?: string }>('thread/start', { cwd: this.spec.cwd ?? process.cwd() });
      this._resumeCursor = started?.thread_id ?? started?.threadId;
      if (this._resumeCursor) this.turn?.onEvent({ kind: 'session', sessionId: this._resumeCursor });
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'codex/event' || !this.turn || this.turn.done) return;
    for (const n of normalizeCodexEvent(params)) {
      if (n.t === 'text') {
        if (n.final && this.turn.sawDelta) continue; // a final agent_message that repeats the stream
        if (!n.final) this.turn.sawDelta = true;
        this.turn.text += n.text;
        this.turn.onEvent({ kind: 'text', delta: n.text });
      } else {
        this.turn.onEvent({ kind: 'tool', phase: 'start', name: n.name });
      }
    }
  }

  private settle(reason: SessionStopReason, error?: string): void {
    const t = this.turn;
    if (!t || t.done) return;
    t.done = true;
    t.settledReason = reason;
    t.onEvent({ kind: 'done', reason, ...(error ? { error } : {}) });
  }

  async prompt(text: string, handlers: AgentSessionHandlers): Promise<AgentSessionTurn> {
    // Set the turn BEFORE open(): the handshake (thread/start) captures the
    // session id and emits it to the active turn.
    const t: CodexTurn = { onEvent: handlers.onEvent, text: '', sawDelta: false, done: false };
    this.turn = t;
    this.stderr = '';
    if (handlers.signal?.aborted) { this.settle('interrupted'); return { text: '', reason: 'interrupted' }; }
    const onAbort = (): void => { void this.interrupt(); };
    handlers.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (!this.rpc?.running) await this.open();
      // The turn/start RESPONSE is the turn boundary; notifications stream in between.
      await this.rpc!.request('turn/start', { thread_id: this._resumeCursor, input: [{ type: 'text', text }] });
      if (!t.done) this.settle('stop');
    } catch (err) {
      if (!t.done) this.settle('error', err instanceof Error ? err.message : String(err));
    } finally {
      handlers.signal?.removeEventListener('abort', onAbort);
    }
    return { text: t.text, reason: t.settledReason ?? 'stop' };
  }

  async interrupt(): Promise<void> {
    try { await this.rpc?.request('turn/interrupt', { thread_id: this._resumeCursor }); } catch { /* best effort */ }
    this.settle('interrupted');
  }

  async close(): Promise<void> {
    this.settle('interrupted');
    this.rpc?.kill();
    this.rpc = undefined;
  }
}
